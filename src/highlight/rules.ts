/**
 * 确定性短路规则(纯函数,任何 provider 之前先跑)。
 *
 * 能用规则定下来的事不花 token —— 这是 Agentero #598「规则优先于 jEV」的要点,
 * 也是最省钱的护栏:整站的代码块、导航、目录、重复标题、纯符号块占比不小,
 * 把它们挡在模型前面,预算才能真正花在正文上。
 *
 * 每条规则返回「跳过原因」字符串(进响应的 degraded),或 null 表示放行。
 */
import type { JudgeBlock } from './judge.ts';

export interface RuleSkip {
  id: string;
  reason: string;
}

export interface RuleResult {
  kept: JudgeBlock[];
  skipped: RuleSkip[];
}

/** 去空白后短于此长度的块不值得高亮(多为小标题/标签/碎片)。 */
export const MIN_RULE_CHARS = 8;

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const LATIN_RE = /[a-zA-Z]/;
const CODE_HINT_RE =
  /\b(function|const|let|var|def|class|import|export|async|await|return|SELECT|INSERT|UPDATE|npm|pip|yarn|docker|curl|git|node)\b/;
const SYMBOL_RE = /[{}();=<>[\]|&$#@\\`~^]/g;
const NAV_LINE_RE =
  /^(上[一页篇]|下[一页篇]|返回|回到顶部|目录|导航|侧边栏|页脚|分享|复制链接|编辑此页|报告问题|上一篇|下一篇)/;
const NAV_EN_RE = /^(was this page helpful|previous|next|table of contents|back to top|share|edit this page)/i;
const SEPARATOR_RE = /[·•・›»]/g;
/** 分隔符连着出现的次数达到该值且整块较短 → 判为目录/导航条。 */
export const NAV_SEPARATOR_MIN = 3;
export const NAV_MAX_CHARS = 200;

function symbolDensity(text: string): number {
  const matched = text.match(SYMBOL_RE);
  if (matched === null || text.length === 0) return 0;
  return matched.length / text.length;
}

/** 纯数字/符号/空白,没有任何可读文字。 */
export function isUnreadable(text: string): boolean {
  const bare = text.trim();
  if (bare.length === 0) return true;
  const hasCjk = CJK_RE.test(bare);
  const hasLatin = LATIN_RE.test(bare);
  return !hasCjk && !hasLatin;
}

/** 代码块:含代码关键词且符号密度高,或符号密度本身就已说明问题。 */
export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (/^(```|~~~)/.test(trimmed)) return true;
  const density = symbolDensity(trimmed);
  if (density > 0.18) return true;
  return CODE_HINT_RE.test(trimmed) && density > 0.05;
}

/** 导航 / 目录文本:不该被高亮,也不该占用预算。 */
export function looksLikeNavigation(text: string): boolean {
  const trimmed = text.trim();
  if (NAV_LINE_RE.test(trimmed) || NAV_EN_RE.test(trimmed)) return true;
  const separators = trimmed.match(SEPARATOR_RE);
  if (
    separators !== null &&
    separators.length >= NAV_SEPARATOR_MIN &&
    trimmed.length <= NAV_MAX_CHARS
  ) {
    return true;
  }
  return false;
}

/** 归一化后用于判重:去空白、全角转半角、转小写。 */
export function dedupeKey(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[　]/g, '');
}

export interface RuleContext {
  /** 已放行的块(判重用);页面标题也预先塞进去,与标题相同的块直接跳过。 */
  seen: Set<string>;
}

/**
 * 按顺序跑全部规则:
 *  - 任一规则命中 → 该块进 skipped(带原因),不进 kept;
 *  - 全部放行 → 记入 seen(供后续块判重),进 kept。
 *
 * 判重是「同一次请求内」的:跨请求的重复由前端分块时避免。
 */
export function applyRules(blocks: JudgeBlock[], pageTitle: string): RuleResult {
  const titleKey = dedupeKey(pageTitle);
  const seen = new Set<string>();
  if (titleKey.length > 0) seen.add(titleKey);

  const kept: JudgeBlock[] = [];
  const skipped: RuleSkip[] = [];

  for (const block of blocks) {
    const key = dedupeKey(block.text);
    const reason = decide(block.text, key, seen);
    if (reason === null) {
      seen.add(key);
      kept.push(block);
    } else {
      skipped.push({ id: block.id, reason });
    }
  }
  return { kept, skipped };
}

/** 单块的判定:命中则返回跳过原因,放行返回 null。 */
function decide(text: string, key: string, seen: Set<string>): string | null {
  if (key.length < MIN_RULE_CHARS) return 'too_short';
  if (isUnreadable(text)) return 'unreadable';
  if (looksLikeCode(text)) return 'code';
  if (looksLikeNavigation(text)) return 'navigation';
  if (seen.has(key)) return 'duplicate';
  return null;
}
