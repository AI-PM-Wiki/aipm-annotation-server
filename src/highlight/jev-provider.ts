/**
 * Jev provider(TypeSafe System One,主判分器)。
 *
 * 为什么是它:这是**类型化决策 API**,不是自由文本生成 —— 一次请求批量问 N 个
 * 独立问题(各回各的 key),`noul` 回概率、`choice` 回选项+分布+confidence、
 * `score` 回档位。所以「该不该高亮 / 用什么颜色 / 多重要」要编码成批量 typed
 * questions 再由代码组装,而不是写一段 prompt 让它生成 JSON。
 *
 * 请求形状(2026-09 核对 docs.typesafe.ai/api.md):
 *   POST {base}/v1/systemone  {state, model, questions:{<id>:{type, instructions, criteria}}}
 *   choice 的 options 就是 criteria 这个 map 的键(值是该选项的说明);
 *   noul 的 criteria 是 {true, false};score 的 criteria 是有序档位描述数组。
 * 响应:{model, answers:{<id>: ...}, usage:{input_tokens, output_tokens}}。
 *
 * 上限:state + 全部问题 ≤ 64k token(单问题 ≤ 32k);1200 rpm / 250k tok/s,超限 429。
 */
import type {
  HighlightJudge,
  JudgeBlock,
  JudgeChunkRequest,
  JudgeOutcome,
  JudgeUsage,
  PaletteEntry,
  Suggestion,
} from './judge.ts';
import { JudgeError } from './judge.ts';

export interface JevProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

interface JevAnswer {
  noul?: unknown;
  choice?: unknown;
  score?: unknown;
  confidence?: unknown;
}

/** 每个块问三个问题;键用 `b<块id>.<字段>`,块 id 已被请求校验限定为安全字符集。 */
export type JevField = 'worth' | 'purpose' | 'importance';

export function questionKey(blockId: string, field: JevField): string {
  return `b${blockId}.${field}`;
}

/** 把一块文本编成编号片段(带块 id),让模型能一一对回。 */
export function buildState(
  pageTitle: string,
  palette: PaletteEntry[],
  blocks: JudgeBlock[],
): string {
  const paletteLines = palette
    .map((p) => `- ${p.id}:${p.label}(${p.when})`)
    .join('\n');
  const blockLines = blocks.map((b) => `[${b.id}]\n${b.text}`).join('\n\n');
  return [
    `页面标题:${pageTitle}`,
    '',
    '可用的高亮颜色:',
    paletteLines,
    '',
    '待判定的正文片段(每段以方括号里的 id 开头):',
    blockLines,
  ].join('\n');
}

export function buildQuestions(
  blocks: JudgeBlock[],
  palette: PaletteEntry[],
): { questions: Record<string, unknown>; keys: Map<string, { blockId: string; field: JevField }> } {
  const questions: Record<string, unknown> = {};
  const keys = new Map<string, { blockId: string; field: JevField }>();
  // choice 的选项 = 色板 id,选项说明 = 该颜色的使用语义
  const colorCriteria: Record<string, string> = {};
  for (const p of palette) colorCriteria[p.id] = p.when;

  for (const block of blocks) {
    const worth = questionKey(block.id, 'worth');
    questions[worth] = {
      type: 'noul',
      instructions:
        `编号 ${block.id} 这段文字,是否值得读者在技术文档里划线高亮?` +
        '只有承载实质信息(定义、结论、数据、坑、关键例子)的段落才值得;' +
        '过渡句、寒暄、目录、导航、代码、零散短语不值得。',
      criteria: {
        true: '值得高亮:读者回头找信息时会想再看到它',
        false: '不值得高亮:删掉它不影响读者理解这一节',
      },
    };
    keys.set(worth, { blockId: block.id, field: 'worth' });

    const purpose = questionKey(block.id, 'purpose');
    questions[purpose] = {
      type: 'choice',
      instructions: `编号 ${block.id} 这段文字若被高亮,最贴切的颜色语义是哪一类?`,
      criteria: colorCriteria,
    };
    keys.set(purpose, { blockId: block.id, field: 'purpose' });

    const importance = questionKey(block.id, 'importance');
    questions[importance] = {
      type: 'score',
      instructions: `编号 ${block.id} 这段文字对该页主题的重要程度是几级?`,
      criteria: [
        '0 级:可直接忽略的边角信息',
        '1 级:有点用,但读者不记住也不影响',
        '2 级:重要,属于这一节的主干信息',
        '3 级:非常关键,漏掉它这一节就白读了',
      ],
    };
    keys.set(importance, { blockId: block.id, field: 'importance' });
  }
  return { questions, keys };
}

function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * 把 Jev 的 answers 组装成统一 Suggestion[]。
 * 纯函数(不触网),因此「答案怎么映射成建议」这条最容易出错的逻辑可以直接单测。
 */
export function assembleSuggestions(
  answers: Record<string, JevAnswer>,
  blocks: JudgeBlock[],
  keys: Map<string, { blockId: string; field: JevField }>,
  palette: PaletteEntry[],
  fallbackColor: string | null,
): Suggestion[] {
  const byBlock = new Map<string, Partial<Record<JevField, JevAnswer>>>();
  for (const [key, meta] of keys) {
    const answer = answers[key];
    if (answer === undefined || answer === null || typeof answer !== 'object') continue;
    let slot = byBlock.get(meta.blockId);
    if (slot === undefined) {
      slot = {};
      byBlock.set(meta.blockId, slot);
    }
    slot[meta.field] = answer;
  }

  const paletteIds = new Set(palette.map((p) => p.id));
  const out: Suggestion[] = [];
  for (const block of blocks) {
    const slot = byBlock.get(block.id);
    if (slot === undefined) continue;
    const worthAnswer = slot.worth;
    const worth = worthAnswer === undefined ? null : toNumber(worthAnswer.noul);
    if (worth === null) continue;

    const purposeAnswer = slot.purpose;
    const rawChoice = purposeAnswer?.choice;
    const color =
      typeof rawChoice === 'string' && paletteIds.has(rawChoice) ? rawChoice : fallbackColor;

    const importanceAnswer = slot.importance;
    const rawScore = importanceAnswer === undefined ? null : toNumber(importanceAnswer.score);
    const importance = rawScore === null ? 0 : Math.min(3, Math.max(0, Math.round(rawScore)));

    // 原生 confidence 取该块各答案里最小的一个(最保守)
    const confidences: number[] = [];
    for (const answer of [purposeAnswer, importanceAnswer]) {
      const c = answer === undefined ? null : toNumber(answer.confidence);
      if (c !== null) confidences.push(clamp01(c));
    }

    out.push({
      id: block.id,
      worth: clamp01(worth),
      color,
      // category 与 color 同源:色板本身就是按语义分的,取色板条目的短标签
      // (如「术语」「结论」)供图例展示;保留独立字段是为了日后接自定义类别
      // 时不必改契约。
      category: palette.find((p) => p.id === color)?.label ?? color ?? 'other',
      importance,
      confidence: confidences.length === 0 ? null : Math.min(...confidences),
      source: 'jev',
    });
  }
  return out;
}

export class JevJudge implements HighlightJudge {
  readonly name = 'jev' as const;
  private readonly opts: JevProviderOptions;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JevProviderOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get available(): boolean {
    return this.opts.apiKey.length > 0;
  }

  async judge(request: JudgeChunkRequest): Promise<JudgeOutcome> {
    if (!this.available) throw new JudgeError('unavailable', '未配置 TYPESAFE_API_KEY');
    const { blocks } = request.chunk;
    if (blocks.length === 0) return { suggestions: [] };

    const { questions, keys } = buildQuestions(blocks, request.palette);
    const payload = {
      state: buildState(request.title, request.palette, blocks),
      model: this.opts.model,
      questions,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const onExternalAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onExternalAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.opts.baseUrl}/v1/systemone`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.opts.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new JudgeError('timeout', 'Jev 调用超时');
      throw new JudgeError('http', err instanceof Error ? err.message : 'Jev 请求失败');
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (response.status === 429 || response.status === 529) {
      const retryAfter = Number(response.headers.get('retry-after') ?? '');
      throw new JudgeError(
        'rate_limited',
        `Jev 限流(HTTP ${response.status})`,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60,
      );
    }
    if (!response.ok) {
      throw new JudgeError('http', `Jev HTTP ${response.status}`);
    }

    let body: { model?: unknown; answers?: unknown; usage?: unknown };
    try {
      body = (await response.json()) as typeof body;
    } catch {
      throw new JudgeError('shape', 'Jev 响应不是 JSON');
    }
    const answers = body.answers;
    if (answers === null || typeof answers !== 'object' || Array.isArray(answers)) {
      throw new JudgeError('shape', 'Jev 响应缺少 answers');
    }

    const suggestions = assembleSuggestions(
      answers as Record<string, JevAnswer>,
      blocks,
      keys,
      request.palette,
      request.palette[0]?.id ?? null,
    );
    if (suggestions.length === 0) {
      // 一个块都没解析出来 = 形状不对(而不是「都不值得高亮」),交给编排器回退
      throw new JudgeError('shape', 'Jev 未返回任何可用答案');
    }

    const outcome: JudgeOutcome = { suggestions };
    if (typeof body.model === 'string') outcome.model = body.model;
    const usage = body.usage;
    if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
      const u = usage as Record<string, unknown>;
      const inputTokens = toNumber(u.input_tokens);
      const outputTokens = toNumber(u.output_tokens);
      const summarized: JudgeUsage = {};
      if (inputTokens !== null) summarized.inputTokens = inputTokens;
      if (outputTokens !== null) summarized.outputTokens = outputTokens;
      outcome.usage = summarized;
    }
    return outcome;
  }
}
