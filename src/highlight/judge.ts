/**
 * 判分的 provider 无关契约。
 *
 * 这里是整个高亮子系统**唯一**被业务逻辑认识的形状:`HighlightJudge.judge(chunk)`
 * 进,统一 `Suggestion[]` 出。两个 provider(Jev / LLM)的输入输出格式差异是本质的
 * ——Jev 是「一次批量问 N 个类型化问题、各回各的 key、答案自带 calibrated confidence」,
 * LLM 是「提示词进、自由文本出、自己解析并校验」——但那是两个适配器内部的事:
 * provider 独有字段(probabilities、legend、usage 明细)只留在 provider 内部与
 * 响应元数据里,绝不渗进业务逻辑。
 */

export interface PaletteEntry {
  id: string;
  label: string;
  /** 该颜色的使用语义(如「定义/术语」「关键结论」),Jev 的 choice 选项描述取自这里。 */
  when: string;
}

export interface JudgeBlock {
  id: string;
  text: string;
}

export interface Chunk {
  /** 片序号(从 0 起),用于进度显示。 */
  index: number;
  blocks: JudgeBlock[];
}

export type JudgeSource = 'rules' | 'jev' | 'llm';

/** 统一的判定结果。业务逻辑只看得懂这个。 */
export interface Suggestion {
  id: string;
  /** 该不该高亮,0..1。 */
  worth: number;
  /** 色板 id;null = 交给前端用默认色。 */
  color: string | null;
  /** 语义类别(短标签,用于图例与排序展示)。 */
  category: string;
  /** 重要性 0..3,用于排序与每页建议数上限。 */
  importance: number;
  /** 原生 calibrated confidence;LLM 自报不可信,统一 null。 */
  confidence: number | null;
  source: JudgeSource;
}

export interface JudgeUsage {
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

export interface JudgeOutcome {
  suggestions: Suggestion[];
  /** provider 报回的模型 id(如 jev-1.13.0 / claude-haiku-4-5)。 */
  model?: string;
  usage?: JudgeUsage;
}

export interface JudgeChunkRequest {
  page: string;
  title: string;
  palette: PaletteEntry[];
  chunk: Chunk;
  totalChunks: number;
  signal?: AbortSignal;
}

/** provider 调用失败的可解释原因(用于回退判定与日志)。 */
export class JudgeError extends Error {
  /** 'rate_limited' | 'timeout' | 'http' | 'shape' | 'low_confidence' | 'unavailable' */
  readonly code: string;
  readonly retryAfterSec?: number;
  /**
   * 失败前已经真实产生的用量 —— 调用失败不等于没花钱(例如两次输出都解析不了,
   * token 照扣)。编排器据此结算预算,不把失败当成零成本。
   */
  readonly usage?: JudgeUsage;

  constructor(code: string, message: string, retryAfterSec?: number, usage?: JudgeUsage) {
    super(message);
    this.code = code;
    this.name = 'JudgeError';
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
    if (usage !== undefined) this.usage = usage;
  }
}

export interface HighlightJudge {
  readonly name: 'jev' | 'llm';
  /** key / 依赖缺失时为 false → 编排器直接跳过并考虑回退。 */
  readonly available: boolean;
  judge(request: JudgeChunkRequest): Promise<JudgeOutcome>;
}

/**
 * 片级置信度:只统计有原生 confidence 的建议(因此 LLM 的结果恒为 null,
 * 阈值策略对 LLM 自动不生效 —— 它自报的置信度不可信,这是刻意的)。
 */
export function chunkConfidence(suggestions: Suggestion[]): number | null {
  const values: number[] = [];
  for (const s of suggestions) if (s.confidence !== null) values.push(s.confidence);
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 统一收敛:把任何 provider 的抛错都归成 JudgeError,便于回退判定。 */
export function toJudgeError(err: unknown, fallbackCode = 'http'): JudgeError {
  if (err instanceof JudgeError) return err;
  if (err instanceof Error && err.name === 'AbortError') {
    return new JudgeError('timeout', '调用超时或被取消');
  }
  return new JudgeError(fallbackCode, err instanceof Error ? err.message : String(err));
}
