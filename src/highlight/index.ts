/**
 * 智能高亮的编排层:校验 → 规则短路 → 分片 → provider 路由与回退 → 组装 → 缓存。
 *
 * 路由形状借自 poco-ai/Agentero#598 的 Decision Layer 抽象(规则/jEV/LLM 是平等的
 * provider,routing 描述主选与回退),但只借形状不借代码:那里是 Rust 草案,这里是
 * 一个具体的两 provider 实现。
 *
 * 关键取舍:
 *  - **规则先跑**:确定性判断(过短、纯符号、代码、导航、重复)在任何 provider 之前
 *    短路,不花 token。
 *  - **回退是可解释的**:响应里 `judge` 说明本次实际生效的 provider,`fallbackFrom`
 *    标明发生过回退及来源,便于排查与日后 A/B。
 *  - **阈值只对有原生 confidence 的 provider 生效**:Jev 低置信 → 回退 LLM;
 *    LLM 自报置信度不可信(统一 null),阈值对它天然不适用。
 *  - **结果只作建议**:本层只返回建议,不写任何批注数据;采纳与否由前端决定。
 */
import { DailyBudget, DailyCounter } from '../budget.ts';
import type { Config } from '../config.ts';
import {
  SlidingWindowLimiter,
  Semaphore,
  SemaphoreError,
  mapWithConcurrency,
} from '../rate-limit.ts';
import { canonicalPage, hashPageText, verifyBlocks } from '../index-store.ts';
import { chunkBlocks } from './blocks.ts';
import type {
  Chunk,
  HighlightJudge,
  JudgeBlock,
  JudgeSource,
  JudgeUsage,
  PaletteEntry,
  Suggestion,
} from './judge.ts';
import { JudgeError, chunkConfidence } from './judge.ts';
import { applyRules } from './rules.ts';

export const PALETTE_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
export const BLOCK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const MAX_PALETTE_ENTRIES = 12;

export interface HighlightRequest {
  page: string;
  title: string;
  palette: PaletteEntry[];
  blocks: JudgeBlock[];
  judge: 'auto' | 'jev' | 'llm';
}

export interface DegradedBlock {
  id: string;
  reason: string;
}

export interface SuggestBody {
  judge: JudgeSource;
  fallbackFrom?: 'jev' | 'llm';
  model?: string;
  suggestions: Suggestion[];
  degraded: DegradedBlock[];
  usage?: JudgeUsage;
  /** 命中同页缓存时为 true(此时不会再调 provider,也不再计费)。 */
  cached?: boolean;
}

export type SuggestResult =
  | { ok: true; body: SuggestBody }
  | { ok: false; status: number; code: string; message: string; retryAfterSec?: number };

export interface PageIndexLike {
  hasPage(page: string): boolean;
  pageText(page: string): string;
}

export interface HighlightServiceDeps {
  config: Config;
  judges: { jev: HighlightJudge; llm: HighlightJudge };
  index: PageIndexLike;
  now?: () => number;
}

/** 单片判分的完整结果;请求级累加器由调用方按片序合并。 */
interface ChunkOutcome {
  /** null = 该片没拿到任何有效建议(原因已写进 degraded)。 */
  suggestions: Suggestion[] | null;
  costUsd: number;
  degraded: DegradedBlock[];
  usedFallbackFrom: 'jev' | 'llm' | null;
  effective: 'jev' | 'llm' | null;
  budgetBlocked: boolean;
  model?: string;
  usage?: JudgeUsage;
}

interface CacheEntry {
  expiresAt: number;
  body: SuggestBody;
}

/** 校验失败的原因,与 HTTP 400 一一对应。 */
class BadRequest extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = 'BadRequest';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizePalette(raw: unknown): PaletteEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: PaletteEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw.slice(0, MAX_PALETTE_ENTRIES)) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (typeof id !== 'string' || !PALETTE_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = typeof item.label === 'string' && item.label.length > 0 ? item.label.slice(0, 40) : id;
    const when = typeof item.when === 'string' ? item.when.slice(0, 200) : label;
    out.push({ id, label, when });
  }
  return out;
}

export function normalizeJudgeBlocks(raw: unknown): JudgeBlock[] {
  if (!Array.isArray(raw)) return [];
  const out: JudgeBlock[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const id = item.id;
    const text = item.text;
    if (typeof id !== 'string' || !BLOCK_ID_RE.test(id) || seen.has(id)) continue;
    if (typeof text !== 'string' || text.trim().length === 0) continue;
    seen.add(id);
    out.push({ id, text });
  }
  return out;
}

export class HighlightService {
  private readonly config: Config;
  private readonly judges: { jev: HighlightJudge; llm: HighlightJudge };
  private readonly index: PageIndexLike;
  private readonly now: () => number;

  /** 判分专属限流(按 IP),比批注接口更严:一次判分就是一次真金白银的调用。 */
  readonly limiter: SlidingWindowLimiter;
  readonly semaphore: Semaphore;
  readonly budget: DailyBudget;
  readonly jevCalls: DailyCounter;
  readonly llmCalls: DailyCounter;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(deps: HighlightServiceDeps) {
    this.config = deps.config;
    const h = deps.config.highlight;
    this.judges = deps.judges;
    this.index = deps.index;
    this.now = deps.now ?? (() => Date.now());
    this.limiter = new SlidingWindowLimiter(h.rateLimitMax, h.rateLimitWindowMs);
    this.semaphore = new Semaphore(deps.config.concurrencyLimit, {
      queueLimit: deps.config.queueLimit,
      waitMs: deps.config.queueWaitMs,
    });
    this.budget = new DailyBudget(h.dailyBudgetUsd, () => new Date(this.now()));
    this.jevCalls = new DailyCounter(h.dailyCallsJev, () => new Date(this.now()));
    this.llmCalls = new DailyCounter(h.dailyCallsLlm, () => new Date(this.now()));
  }

  /** 两个 provider 的可用性 + 护栏水位(供 /healthz 展示)。 */
  healthSnapshot(): Record<string, unknown> {
    const h = this.config.highlight;
    return {
      judges: {
        jev: { available: this.judges.jev.available, callsToday: this.jevCalls.usedCount },
        llm: { available: this.judges.llm.available, callsToday: this.llmCalls.usedCount },
      },
      routing: {
        primary: h.primary,
        fallback: h.fallback,
        fallbackThreshold: h.fallbackThreshold,
        worthThreshold: h.worthThreshold,
      },
      budget: {
        spentUsd: Number(this.budget.spentUsd.toFixed(6)),
        remainingUsd:
          this.budget.remainingUsd === Number.POSITIVE_INFINITY
            ? null
            : Number(this.budget.remainingUsd.toFixed(6)),
      },
      cacheEntries: this.cache.size,
    };
  }

  private cacheKey(page: string, contentHash: string, req: HighlightRequest): string {
    const paletteVersion = req.palette.map((p) => `${p.id}:${p.when}`).join(',');
    return `${page}\u0000${contentHash}\u0000${req.judge}\u0000${paletteVersion}`;
  }

  private readCache(key: string, wanted: Set<string>): SuggestBody | null {
    const entry = this.cache.get(key);
    if (entry === undefined) return null;
    if (entry.expiresAt <= this.now()) {
      this.cache.delete(key);
      return null;
    }
    /* 命中但要按本次请求的块集合过滤:缓存是同页的整页结果,请求可能只要其中一部分。
       degraded 同样要过滤 —— 它是「这一页哪些块没给建议」的逐块记录,掺进本次没发
       的块,面板上的「N 段未判定」就会数到用户根本没送出去的段落。 */
    const suggestions = entry.body.suggestions.filter((s) => wanted.has(s.id));
    if (suggestions.length === 0 && entry.body.suggestions.length > 0) return null;
    const degraded = entry.body.degraded.filter((d) => wanted.has(d.id));
    return { ...entry.body, suggestions, degraded, cached: true };
  }

  private writeCache(key: string, body: SuggestBody): void {
    const h = this.config.highlight;
    if (h.cacheTtlMs <= 0 || h.cacheMaxEntries <= 0) return;
    if (this.cache.size >= h.cacheMaxEntries) {
      // 简易 LRU:Map 保持插入序,淘汰最旧的一条
      const oldest = this.cache.keys().next();
      if (!oldest.done) this.cache.delete(oldest.value);
    }
    this.cache.set(key, { expiresAt: this.now() + h.cacheTtlMs, body: { ...body, cached: undefined } });
  }

  /**
   * 请求校验:不合规一律 400,并且**在任何模型调用之前**判完。
   *
   * 抽样校验按块给结论:验不过的块就地丢掉(它们不是这一页的正文 —— 主题模板文字、
   * 客户端渲染的公式等),交给调用方写进 degraded;只有「一块都验不过」才 400。
   * 于是能进模型的仍然只有索引里找得到的文本,而一个页脚段落不会再让整页失败。
   */
  private validate(raw: HighlightRequest): {
    page: string;
    title: string;
    blocks: JudgeBlock[];
    rejected: DegradedBlock[];
  } {
    const h = this.config.highlight;
    const page = canonicalPage(raw.page);
    if (page === null) throw new BadRequest('invalid_page', 'page 必须是本站路径');
    if (!this.index.hasPage(page)) {
      throw new BadRequest('page_not_indexed', '该页面不在站内索引里,无法校验正文');
    }
    if (raw.palette.length === 0) throw new BadRequest('invalid_palette', 'palette 不能为空');
    if (raw.blocks.length === 0) throw new BadRequest('invalid_blocks', 'blocks 不能为空');
    if (raw.blocks.length > h.maxBlocksPerRequest) {
      throw new BadRequest('too_many_blocks', `块数超过每请求上限 ${h.maxBlocksPerRequest}`);
    }
    let chars = 0;
    for (const b of raw.blocks) chars += b.text.length;
    if (chars > h.maxCharsPerRequest) {
      throw new BadRequest('too_many_chars', `总字符数超过每请求上限 ${h.maxCharsPerRequest}`);
    }
    // 防「拿端点当免费 LLM 代理」:正文抽样必须能在站内索引里找到。
    // 一块都验不过 = 要么这不是本站的正文,要么索引与页面已经对不上 —— 拒掉。
    const verdict = verifyBlocks(this.index.pageText(page), raw.blocks, this.config.indexSampleChars);
    if (verdict.accepted.length === 0) {
      const first = verdict.rejected[0]!;
      throw new BadRequest('blocks_not_in_page', `块 ${first.id} 的文本不属于该页面(${first.reason})`);
    }
    return {
      page,
      title: raw.title.slice(0, 300),
      blocks: verdict.accepted,
      rejected: verdict.rejected,
    };
  }

  /** provider 链:主选 + 回退(同名或 none 时不重复)。 */
  private chain(preference: 'auto' | 'jev' | 'llm'): Array<'jev' | 'llm'> {
    const h = this.config.highlight;
    const primary = preference === 'auto' ? h.primary : preference;
    const fallback = h.fallback === 'none' || h.fallback === primary ? null : h.fallback;
    return fallback === null ? [primary] : [primary, fallback];
  }

  private counterFor(name: 'jev' | 'llm'): DailyCounter {
    return name === 'jev' ? this.jevCalls : this.llmCalls;
  }

  /** 每次调用的理论最大成本(用于预算预占)。 */
  private estimateCost(name: 'jev' | 'llm', chunk: Chunk): number {
    const h = this.config.highlight;
    let chars = 0;
    for (const b of chunk.blocks) chars += b.text.length;
    // 中文约 1–2 字/token,取 /2 作为保守估计;prompt 模板与色板开销按 400 字加回
    const inputTokens = Math.ceil((chars + 400) / 2);
    if (name === 'jev') return (inputTokens * h.jevInputCostPerMtok) / 1_000_000;
    // LLM 输出按每块 40 token 估,上限 llmMaxTokens
    const outputTokens = Math.min(h.llmMaxTokens, chunk.blocks.length * 40);
    return (
      (inputTokens * h.llmInputCostPerMtok + outputTokens * h.llmOutputCostPerMtok) / 1_000_000
    );
  }

  private async judgeChunk(
    name: 'jev' | 'llm',
    req: HighlightRequest,
    chunk: Chunk,
    totalChunks: number,
    signal?: AbortSignal,
  ): Promise<{ suggestions: Suggestion[]; model?: string; usage?: JudgeUsage; costUsd: number }> {
    const judge = name === 'jev' ? this.judges.jev : this.judges.llm;
    if (!judge.available) throw new JudgeError('unavailable', `${name} provider 未配置`);
    if (!this.counterFor(name).tryAcquire()) {
      throw new JudgeError('unavailable', `${name} 今日调用次数已用完`);
    }
    const outcome = await judge.judge({
      page: req.page,
      title: req.title,
      palette: req.palette,
      chunk,
      totalChunks,
      ...(signal === undefined ? {} : { signal }),
    });
    const result: {
      suggestions: Suggestion[];
      model?: string;
      usage?: JudgeUsage;
      costUsd: number;
    } = { suggestions: outcome.suggestions, costUsd: outcome.usage?.costUsd ?? 0 };
    if (outcome.model !== undefined) result.model = outcome.model;
    if (outcome.usage !== undefined) result.usage = outcome.usage;
    return result;
  }

  /**
   * 单片:预算预占 → 主选(必要时兜底)→ 结算,返回这一片的结果。
   *
   * 片内逻辑与请求级累加器分开,是为了让多片能并发跑:片之间本来就没有依赖,
   * 抽出结果后由调用方**按片序**合并,于是并发与串行的产出逐字节一致
   * (degraded 的顺序、effective / usedFallbackFrom 的取值都不会漂)。
   */
  private async judgeOneChunk(
    chunk: Chunk,
    available: Array<'jev' | 'llm'>,
    raw: HighlightRequest,
    page: string,
    title: string,
    totalChunks: number,
    signal?: AbortSignal,
  ): Promise<ChunkOutcome> {
    const h = this.config.highlight;
    const first = available[0]!;
    const second = available[1];
    const degraded: DegradedBlock[] = [];
    let costUsd = 0;
    let usedFallbackFrom: 'jev' | 'llm' | null = null;
    let effective: 'jev' | 'llm' | null = null;
    let budgetBlocked = false;

    /** 本片当前未结算的预占额(0 = 无未结预占)。 */
    let reserved = this.estimateCost(first, chunk);
    if (!this.budget.tryReserve(reserved)) {
      for (const b of chunk.blocks) degraded.push({ id: b.id, reason: 'budget_exhausted' });
      return {
        suggestions: null,
        costUsd: 0,
        degraded,
        usedFallbackFrom: null,
        effective: null,
        budgetBlocked: true,
      };
    }

    let chunkSuggestions: Suggestion[] | null = null;
    let chunkUsage: JudgeUsage | undefined;
    let chunkModel: string | undefined;
    /** 主选回了低置信但有效的结果:兜底也失败时用它,别把已有的答案丢掉。 */
    let pendingLowConfidence: { suggestions: Suggestion[]; model?: string } | null = null;
    let failureReason = 'unknown';

    for (let i = 0; i < available.length; i++) {
      const name = available[i]!;
      const isFallback = i > 0;
      // 换 provider 要按新 provider 的估价调整预占(只动差额,避免误释放别人的预占)
      const estimate = this.estimateCost(name, chunk);
      if (estimate > reserved) {
        const delta = estimate - reserved;
        if (!this.budget.tryReserve(delta)) {
          this.budget.release(reserved);
          reserved = 0;
          budgetBlocked = true;
          failureReason = 'budget_exhausted';
          break;
        }
        reserved = estimate;
      } else if (estimate < reserved) {
        this.budget.release(reserved - estimate);
        reserved = estimate;
      }

      try {
        const outcome = await this.judgeChunk(
          name,
          { ...raw, page, title },
          chunk,
          totalChunks,
          signal,
        );
        this.budget.settle(reserved, outcome.costUsd);
        reserved = 0;
        costUsd += outcome.costUsd;
        if (outcome.model !== undefined) chunkModel = outcome.model;
        if (outcome.usage !== undefined) chunkUsage = outcome.usage;
        this.logCall(
          name,
          chunk,
          outcome.usage,
          outcome.costUsd,
          page,
          isFallback ? 'fallback' : 'ok',
        );

        const confidence = chunkConfidence(outcome.suggestions);
        if (
          !isFallback &&
          second !== undefined &&
          confidence !== null &&
          confidence < h.fallbackThreshold
        ) {
          // Jev 回得低置信:先留底,再试兜底(阈值只对有原生置信度的 provider 生效)
          pendingLowConfidence = { suggestions: outcome.suggestions };
          if (outcome.model !== undefined) pendingLowConfidence.model = outcome.model;
          failureReason = `low_confidence(${confidence.toFixed(2)})`;
          this.logCall(name, chunk, outcome.usage, 0, page, 'low_confidence');
          continue;
        }
        chunkSuggestions = outcome.suggestions;
        effective = name;
        if (isFallback) usedFallbackFrom = first;
        break;
      } catch (err) {
        const judgeErr = err instanceof JudgeError ? err : new JudgeError('http', String(err));
        const consumed = judgeErr.usage?.costUsd ?? 0;
        this.budget.settle(reserved, consumed);
        reserved = 0;
        costUsd += consumed;
        failureReason = `${judgeErr.code}:${judgeErr.message}`;
        this.logCall(name, chunk, judgeErr.usage, consumed, page, `error:${judgeErr.code}`);
        if (signal?.aborted === true) break; // 客户端已断开,别再花钱
      }
    }

    if (reserved > 0) {
      this.budget.release(reserved);
      reserved = 0;
    }
    if (chunkSuggestions === null && pendingLowConfidence !== null) {
      // 兜底没成功,但主选当时是有有效答案的(只是置信度低)——保留它
      chunkSuggestions = pendingLowConfidence.suggestions;
      if (pendingLowConfidence.model !== undefined) chunkModel = pendingLowConfidence.model;
      effective = first;
    }
    if (chunkSuggestions === null) {
      for (const b of chunk.blocks) degraded.push({ id: b.id, reason: failureReason });
    }

    const result: ChunkOutcome = {
      suggestions: chunkSuggestions,
      costUsd,
      degraded,
      usedFallbackFrom,
      effective,
      budgetBlocked,
    };
    if (chunkUsage !== undefined) result.usage = chunkUsage;
    if (chunkModel !== undefined) result.model = chunkModel;
    return result;
  }

  /**
   * 主入口。限流在最外层(命中缓存则不消耗配额 —— 同页重复点击正是「误触连点」的
   * 常见形态,不该把它打成 429);预算按片预占-结算,失败也把已产生的用量算进去。
   */
  async suggest(
    raw: HighlightRequest,
    ipKey: string,
    signal?: AbortSignal,
  ): Promise<SuggestResult> {
    let page: string;
    let title: string;
    let blocks: JudgeBlock[];
    let rejected: DegradedBlock[];
    try {
      const validated = this.validate(raw);
      page = validated.page;
      title = validated.title;
      blocks = validated.blocks;
      rejected = validated.rejected;
    } catch (err) {
      if (err instanceof BadRequest) {
        return { ok: false, status: 400, code: err.code, message: err.message };
      }
      throw err;
    }

    const h = this.config.highlight;
    const contentHash = hashPageText(this.index.pageText(page));
    const key = this.cacheKey(page, contentHash, raw);
    const wanted = new Set(blocks.map((b) => b.id));
    const hit = this.readCache(key, wanted);
    if (hit !== null) return { ok: true, body: hit };

    /* 校验阶段丢掉的块先入 degraded:它们不是这一页的正文(页脚模板文字之类),
       用户能在「N 段未判定」里看到,而不是被静默吞掉。 */
    const degraded: DegradedBlock[] = rejected.map((r) => ({ id: r.id, reason: r.reason }));

    // 规则先跑:确定性判断不花 token
    const ruled = applyRules(blocks, title);
    for (const s of ruled.skipped) degraded.push({ id: s.id, reason: s.reason });
    if (ruled.kept.length === 0) {
      return { ok: true, body: { judge: 'rules', suggestions: [], degraded } };
    }

    const chunks = chunkBlocks(ruled.kept, {
      chunkBlocks: h.chunkBlocks,
      chunkChars: h.chunkChars,
    });

    const chain = this.chain(raw.judge);
    const available = chain.filter((name) =>
      name === 'jev' ? this.judges.jev.available : this.judges.llm.available,
    );
    if (available.length === 0) {
      // 与下面的「暂时性失败」用不同错误码:这一种是运维没配好,重试无意义,
      // 前端据此禁用按钮;而那一种是排队满/分片全挂,重试有意义,不该把按钮焊死。
      return {
        ok: false,
        status: 503,
        code: 'highlight_not_configured',
        message: '智能高亮当前不可用(服务未配置判分 provider 的密钥)',
      };
    }

    if (!this.limiter.tryAcquire(ipKey)) {
      return {
        ok: false,
        status: 429,
        code: 'rate_limited',
        message: '智能高亮请求过于频繁,请稍后再试',
        retryAfterSec: this.limiter.retryAfterSec(),
      };
    }

    let release: (() => void) | null = null;
    try {
      release = await this.semaphore.acquire(
        signal === undefined ? {} : { signal },
      );
    } catch (err) {
      if (err instanceof SemaphoreError) {
        if (err.code === 'aborted') {
          return { ok: false, status: 499, code: 'client_closed', message: '客户端已断开' };
        }
        return {
          ok: false,
          status: 503,
          code: 'concurrency_limit',
          message: err.code === 'queue_full' ? '服务繁忙,请稍后再试' : '排队超时,请稍后再试',
          retryAfterSec: err.code === 'queue_full' ? 15 : 5,
        };
      }
      throw err;
    }

    try {
      const suggestions: Suggestion[] = [];
      const usage: JudgeUsage = {};
      let requestCostUsd = 0;
      let usedFallbackFrom: 'jev' | 'llm' | null = null;
      let model: string | undefined;
      let effective: 'jev' | 'llm' | null = null;
      let succeeded = 0;
      let budgetBlocked = false;

      /* 交给 provider 的请求只带验过的块 —— providers 只读 chunk,但别留下一条能
         把未校验文本漏进请求对象的路。 */
      const judged: HighlightRequest = { ...raw, blocks };

      /* 片之间没有依赖,按 chunkConcurrency 并发跑;结果按片序合并,与串行语义一致。
         串行版本在最长的那几页(17 片)会超过 Cloudflare ~100s 的代理超时。 */
      const outcomes = await mapWithConcurrency(chunks, h.chunkConcurrency, (chunk) =>
        this.judgeOneChunk(chunk, available, judged, page, title, chunks.length, signal),
      );

      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i]!;
        const chunk = chunks[i]!;
        requestCostUsd += outcome.costUsd;
        if (outcome.budgetBlocked) budgetBlocked = true;
        if (outcome.usedFallbackFrom !== null) usedFallbackFrom = outcome.usedFallbackFrom;
        if (outcome.effective !== null) effective = outcome.effective;
        if (outcome.model !== undefined) model = outcome.model;
        if (outcome.usage !== undefined) {
          usage.inputTokens = (usage.inputTokens ?? 0) + (outcome.usage.inputTokens ?? 0);
          usage.outputTokens = (usage.outputTokens ?? 0) + (outcome.usage.outputTokens ?? 0);
        }
        for (const d of outcome.degraded) degraded.push(d);

        if (outcome.suggestions === null) continue; // 片内已把失败原因写进 degraded
        succeeded++;
        for (const s of outcome.suggestions) {
          if (
            s.worth >= h.worthThreshold &&
            (s.confidence === null || s.confidence >= h.fallbackThreshold)
          ) {
            suggestions.push(s);
          } else {
            degraded.push({ id: s.id, reason: 'below_threshold' });
          }
        }
        for (const b of chunk.blocks) {
          if (!outcome.suggestions.some((s) => s.id === b.id)) {
            degraded.push({ id: b.id, reason: 'no_answer' });
          }
        }
      }

      if (succeeded === 0) {
        if (budgetBlocked) {
          return {
            ok: false,
            status: 429,
            code: 'budget_exhausted',
            message: '今日智能高亮预算已用完,请明天再试',
            retryAfterSec: 24 * 3600,
          };
        }
        return {
          ok: false,
          status: 503,
          code: 'highlight_unavailable',
          message: '智能高亮服务暂时不可用,请稍后再试',
          retryAfterSec: 30,
        };
      }

      // 排序:importance 降序、worth 降序,再按每页上限截断
      suggestions.sort((a, b) => b.importance - a.importance || b.worth - a.worth);
      let finalSuggestions = suggestions;
      if (finalSuggestions.length > h.maxSuggestionsPerPage) {
        for (const dropped of finalSuggestions.slice(h.maxSuggestionsPerPage)) {
          degraded.push({ id: dropped.id, reason: 'over_page_limit' });
        }
        finalSuggestions = finalSuggestions.slice(0, h.maxSuggestionsPerPage);
      }

      const judgeName: JudgeSource =
        usedFallbackFrom !== null ? chain[1]! : (effective ?? chain[0]!);
      const body: SuggestBody = {
        judge: judgeName,
        suggestions: finalSuggestions,
        degraded,
      };
      if (usedFallbackFrom !== null) body.fallbackFrom = usedFallbackFrom;
      if (model !== undefined) body.model = model;
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) {
        usage.costUsd = Number(requestCostUsd.toFixed(6));
        body.usage = usage;
      }
      this.writeCache(key, body);
      return { ok: true, body };
    } finally {
      release?.();
    }
  }

  private logCall(
    judge: 'jev' | 'llm',
    chunk: Chunk,
    usage: JudgeUsage | undefined,
    costUsd: number,
    page: string,
    status: string,
  ): void {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'highlight_judge',
        judge,
        status,
        page,
        chunk: chunk.index,
        blocks: chunk.blocks.length,
        inputTokens: usage?.inputTokens ?? null,
        outputTokens: usage?.outputTokens ?? null,
        costUsd: Number(costUsd.toFixed(6)),
        dailySpentUsd: Number(this.budget.spentUsd.toFixed(6)),
      }),
    );
  }
}
