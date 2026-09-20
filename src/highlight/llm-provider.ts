/**
 * LLM provider(兜底判分器,Anthropic Messages API)。
 *
 * 与 Jev 的差异是**本质的**,不是换个 prompt:
 *  - Jev 一次批量问 N 个独立 typed 问题、各回各的 key;LLM 一次只生成一段输出,
 *    多块必须在输出里自行组织成结构化数组,所以这里用结构化输出
 *    (`output_config.format`)把形状钉死,再用 zod 二次校验。
 *  - Jev 的置信度是原生 calibrated 的;LLM 自报的置信度**不可信**,统一置 null
 *    (于是 fallback_threshold 这个策略对它天然不生效,结果一律标「建议」)。
 *  - 失败模式不同(Jev:429 / early access 无 key;LLM:超时 / JSON 不合法 /
 *    漏块 / 跑题),所以这里失败重试一次并把校验错误回灌,再失败就整片交给
 *    degraded,不静默吞掉。
 *
 * 依赖复用:只多引一个 `@anthropic-ai/sdk`(与问答服务同款同版本),不新增密钥
 * —— 用的是同一个 ANTHROPIC_API_KEY,但预算与调用上限在本服务里独立计。
 */
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod/v4';
import type {
  HighlightJudge,
  JudgeBlock,
  JudgeChunkRequest,
  JudgeOutcome,
  JudgeUsage,
  PaletteEntry,
  Suggestion,
} from './judge.ts';
import { JudgeError, toJudgeError } from './judge.ts';

/** 结构化输出 schema:只描述形状,范围与取值在代码里归一(见 normalizeResults)。 */
export const LlmResultSchema = z.object({
  results: z.array(
    z.object({
      id: z.string(),
      worth: z.number(),
      color: z.string(),
      importance: z.number(),
    }),
  ),
});

const SYSTEM_PROMPT = [
  '你是技术文档的批注助手。读者会在网页上给正文划线高亮,你负责判断哪些段落值得高亮、',
  '该用哪种颜色、有多重要。',
  '',
  '值得高亮的:定义与术语的界定、关键结论、可复用的方法步骤、具体数据与指标、',
  '常见的坑与注意事项、能说明问题的例子、值得记住的原话。',
  '不值得高亮的:过渡句与寒暄、导航与目录、代码块、纯列表标签、重复的标题、',
  '没有信息量的碎片短语。',
  '',
  '颜色必须从给定色板里选,选语义最贴近的那一个。',
  'importance 是 0-3 的整数:0 可忽略,1 有点用,2 重要(本节主干),3 非常关键。',
  'worth 是 0-1 的小数:读者回头找信息时有多想再看到这一段。',
  '每个给定片段都必须给出结果,id 原样回填。',
].join('\n');

export interface LlmCallParams {
  model: string;
  maxTokens: number;
  system: string;
  user: string;
  signal?: AbortSignal;
}

export interface LlmCallResult {
  /** 结构化输出解析后的对象;解析失败为 null。 */
  parsed: unknown;
  usage?: { inputTokens?: number; outputTokens?: number };
  model?: string;
}

/**
 * 真正的模型调用缝:provider 只认识这个函数签名,于是单测可以注入 fake,
 * **不需要联网**(单测禁止真实调用模型)。
 */
export type LlmCaller = (params: LlmCallParams) => Promise<LlmCallResult>;

export interface AnthropicCallerOptions {
  apiKey: string;
  /** SDK 超时(毫秒;TypeScript SDK 的单位是 ms)。 */
  timeoutMs: number;
}

/** 默认实现:Anthropic SDK + `output_config.format` 结构化输出。 */
export function createAnthropicCaller(opts: AnthropicCallerOptions): LlmCaller {
  const client = new Anthropic({
    apiKey: opts.apiKey,
    timeout: opts.timeoutMs,
    // 只留平台侧 1 次重试;调用级重试由 provider 自己做(要把校验错误回灌)
    maxRetries: 1,
  });
  return async (params: LlmCallParams): Promise<LlmCallResult> => {
    const message = await client.messages.parse(
      {
        model: params.model,
        max_tokens: params.maxTokens,
        system: params.system,
        messages: [{ role: 'user', content: params.user }],
        output_config: { format: zodOutputFormat(LlmResultSchema) },
      },
      params.signal === undefined ? undefined : { signal: params.signal },
    );
    return {
      parsed: message.parsed_output ?? null,
      usage: {
        inputTokens: message.usage?.input_tokens,
        outputTokens: message.usage?.output_tokens,
      },
      model: message.model,
    };
  };
}

export interface LlmProviderOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
  caller?: LlmCaller;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 带块编号的正文,让模型能一一对回。 */
export function buildUserPrompt(
  pageTitle: string,
  palette: PaletteEntry[],
  blocks: JudgeBlock[],
): string {
  const paletteLines = palette.map((p) => `- ${p.id}:${p.label}(${p.when})`).join('\n');
  const blockLines = blocks.map((b) => `[${b.id}]\n${b.text}`).join('\n\n');
  return [
    `页面标题:${pageTitle}`,
    '',
    '可用色板:',
    paletteLines,
    '',
    '待判定片段:',
    blockLines,
  ].join('\n');
}

/** 把模型输出归一成统一 Suggestion[](纯函数,可单测)。 */
export function normalizeResults(
  parsed: unknown,
  blocks: JudgeBlock[],
  palette: PaletteEntry[],
): Suggestion[] {
  const record = parsed as { results?: unknown } | null;
  if (record === null || typeof record !== 'object') return [];
  const results = record.results;
  if (!Array.isArray(results)) return [];

  const wanted = new Map(blocks.map((b) => [b.id, b]));
  const paletteIds = new Set(palette.map((p) => p.id));
  const out: Suggestion[] = [];
  const seen = new Set<string>();

  for (const item of results) {
    if (item === null || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const id = entry.id;
    if (typeof id !== 'string' || !wanted.has(id) || seen.has(id)) continue;
    seen.add(id);
    const rawWorth = entry.worth;
    if (typeof rawWorth !== 'number' || !Number.isFinite(rawWorth)) continue;
    const rawColor = entry.color;
    // 模型给了色板外的颜色 → 回落默认色,不因为一个字段丢掉整条建议
    const color = typeof rawColor === 'string' && paletteIds.has(rawColor) ? rawColor : null;
    const rawImportance = entry.importance;
    const importance =
      typeof rawImportance === 'number' && Number.isFinite(rawImportance)
        ? Math.min(3, Math.max(0, Math.round(rawImportance)))
        : 0;
    out.push({
      id,
      worth: clamp01(rawWorth),
      color,
      category: palette.find((p) => p.id === color)?.label ?? color ?? 'other',
      importance,
      // LLM 自报置信度不可信:恒 null。阈值策略因此对它不生效。
      confidence: null,
      source: 'llm',
    });
  }
  return out;
}

export class LlmJudge implements HighlightJudge {
  readonly name = 'llm' as const;
  private readonly opts: LlmProviderOptions;
  private readonly caller: LlmCaller | null;

  constructor(opts: LlmProviderOptions) {
    this.opts = opts;
    this.caller =
      opts.caller ??
      (opts.apiKey.length > 0
        ? createAnthropicCaller({ apiKey: opts.apiKey, timeoutMs: opts.timeoutMs })
        : null);
  }

  get available(): boolean {
    return this.caller !== null;
  }

  /** 单次调用:发请求 → 归一成建议 → 换算用量。任何失败都转成 JudgeError。 */
  private async call(
    user: string,
    blocks: JudgeBlock[],
    palette: PaletteEntry[],
    signal?: AbortSignal,
  ): Promise<{ suggestions: Suggestion[]; usage: JudgeUsage; model?: string }> {
    if (this.caller === null) throw new JudgeError('unavailable', '未配置 ANTHROPIC_API_KEY');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
    const onExternalAbort = () => controller.abort();
    signal?.addEventListener('abort', onExternalAbort, { once: true });
    try {
      const result = await this.caller({
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        system: SYSTEM_PROMPT,
        user,
        signal: controller.signal,
      });
      const inputTokens = result.usage?.inputTokens;
      const outputTokens = result.usage?.outputTokens;
      const usage: JudgeUsage = {};
      if (typeof inputTokens === 'number') usage.inputTokens = inputTokens;
      if (typeof outputTokens === 'number') usage.outputTokens = outputTokens;
      usage.costUsd =
        ((inputTokens ?? 0) * this.opts.inputCostPerMtok +
          (outputTokens ?? 0) * this.opts.outputCostPerMtok) /
        1_000_000;
      const out: { suggestions: Suggestion[]; usage: JudgeUsage; model?: string } = {
        suggestions: normalizeResults(result.parsed, blocks, palette),
        usage,
      };
      if (result.model !== undefined) out.model = result.model;
      return out;
    } catch (err) {
      const status = (err as { status?: unknown }).status;
      if (typeof status === 'number' && (status === 429 || status === 529)) {
        throw new JudgeError('rate_limited', `LLM 限流(HTTP ${status})`, 60);
      }
      if (controller.signal.aborted) throw new JudgeError('timeout', 'LLM 调用超时');
      throw toJudgeError(err);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }
  }

  /**
   * 一次正常调用 + 一次把校验错误回灌的重试;两次都拿不到任何有效片段就抛
   * shape 错(由编排器决定回退/降级,并计入 degraded)。
   */
  async judge(request: JudgeChunkRequest): Promise<JudgeOutcome> {
    const { blocks } = request.chunk;
    if (blocks.length === 0) return { suggestions: [] };
    const basePrompt = buildUserPrompt(request.title, request.palette, blocks);

    let lastUsage: JudgeUsage | undefined;
    let lastModel: string | undefined;
    let lastReason = '解析后没有任何有效片段(JSON 结构不符,或 id 对不上)';

    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : [
              basePrompt,
              '',
              '上一次的输出有问题,请重新给出完整结果:',
              lastReason,
              '所有片段都必须出现,id 原样回填,颜色必须来自色板。',
            ].join('\n');
      const { suggestions, usage, model } = await this.call(
        prompt,
        blocks,
        request.palette,
        request.signal,
      );
      lastUsage = usage;
      lastModel = model;
      if (suggestions.length > 0) {
        const outcome: JudgeOutcome = { suggestions, usage };
        if (model !== undefined) outcome.model = model;
        return outcome;
      }
    }

    // 两次都不行:把已产生的用量挂在错误上带走(钱已经花了,不能让预算当没花)
    const detail =
      lastModel === undefined
        ? `LLM 两次输出都无法解析:${lastReason}`
        : `LLM(${lastModel})两次输出都无法解析:${lastReason}`;
    throw new JudgeError('shape', detail, undefined, lastUsage);
  }
}
