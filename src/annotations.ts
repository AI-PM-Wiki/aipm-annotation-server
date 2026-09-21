/**
 * 批注领域逻辑:校验、归属、可见性、回复合并、导出。
 *
 * 这里的函数尽量写成纯函数(不碰 IO、不读时钟),IO 由 server.ts 与 store.ts 负责,
 * 这样归属/可见性/合并规则都能直接单测 —— 它们正是最容易写错、也最容易被改错的部分。
 *
 * 三态语义(与前端一致):
 *  - public  存服务端,任何访客不登录也能读。
 *  - private 存服务端,只有作者本人登录后能读(**他人一律 404,不泄露存在性**)。
 *  - local   只在浏览器 localStorage,服务端没有对应路径 —— 本文件不涉及。
 */
import { randomUUID } from 'node:crypto';
import type {
  AnnotationRecord,
  AnnotationStyle,
  Author,
  Reply,
  Selector,
  Visibility,
} from './store.ts';

/** 色板 id 由前端定义,服务端只约束形态(不硬编码色板,便于前端加色)。 */
const PALETTE_ID_RE = /^[a-z][a-z0-9_-]{0,23}$/;
const MAX_SELECTORS = 8;
const MAX_SELECTOR_TEXT = 4_000;

export interface ReplyInput {
  id?: string;
  body: string;
  /** 回复的回复:指向同一条批注下的另一条回复。 */
  parentId?: string;
}

export interface AnnotationInput {
  page: string;
  body: string;
  color: string;
  style: AnnotationStyle;
  visibility: Visibility;
  selectors: Selector[];
  /** 'page' = 全页评论(selectors 可以为空)。 */
  scope?: 'page';
}

export type ValidationError = { ok: false; code: string; detail: string };
export type ValidationOk<T> = { ok: true; value: T };
export type Validation<T> = ValidationOk<T> | ValidationError;

function fail(code: string, detail: string): ValidationError {
  return { ok: false, code, detail };
}

/**
 * 正文校验。
 *
 * `allowEmpty` 只对批注自身的 body 开:智能高亮的产出就是「一段被划了线的话」,
 * 那本来就是一个完整的批注,强制写文字会让「采纳建议」变成「必须写点什么」,
 * 与这个功能的用意相反。**回复仍然不许为空**(回复没有内容就没有意义)。
 */
export function normalizeBody(
  raw: unknown,
  maxChars: number,
  allowEmpty = false,
): Validation<string> {
  if (typeof raw !== 'string') return fail('invalid_body', 'body 必须是字符串');
  const body = raw.trim();
  if (body.length === 0) {
    if (allowEmpty) return { ok: true, value: '' };
    return fail('invalid_body', '批注正文不能为空');
  }
  if (body.length > maxChars) return fail('invalid_body', `批注正文超过 ${maxChars} 字上限`);
  // 控制字符(除换行/制表)一律剔除:防用不可见字符构造混淆内容
  const cleaned = body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  return { ok: true, value: cleaned };
}

export function normalizeColor(raw: unknown): Validation<string> {
  if (typeof raw !== 'string' || !PALETTE_ID_RE.test(raw)) {
    return fail('invalid_color', 'color 必须是合法色板 id');
  }
  return { ok: true, value: raw };
}

/**
 * 画法。**缺省不是错误**:这个字段是后加的,不带 style 的请求按 highlight 处理
 * (与引入它之前的行为一致);带了但认不出来才是错 —— 那说明客户端在乱发。
 */
export function normalizeStyle(raw: unknown): Validation<AnnotationStyle> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: 'highlight' };
  if (raw === 'underline' || raw === 'highlight' || raw === 'both') return { ok: true, value: raw };
  return fail('invalid_style', 'style 只能是 underline / highlight / both');
}

export function normalizeVisibility(raw: unknown): Validation<Visibility> {
  if (raw === 'public' || raw === 'private') return { ok: true, value: raw };
  return fail('invalid_visibility', 'visibility 只能是 public 或 private');
}

/** 逐条校验 selector:类型白名单 + 字段范围。未知类型整条丢弃(不拦请求)。 */
/**
 * 锚点校验。
 *
 * `allowEmpty` 只对全页评论开(调用方按显式 `scope: 'page'` 传入):这类评论按定义
 * 就不锚定任何一段文字,强制「至少一条 selector」等于让它无法存在。**默认仍然拒绝
 * 空数组** ——「传了空数组」与「传了全是非法 selector」在语义上都该被拦下,只有显式
 * 声明了整页语义的才是合法的空。
 */
export function normalizeSelectors(
  raw: unknown,
  opts: { allowEmpty?: boolean } = {},
): Validation<Selector[]> {
  if (!Array.isArray(raw)) return fail('invalid_target', 'selectors 必须是数组');
  const out: Selector[] = [];
  for (const item of raw.slice(0, MAX_SELECTORS)) {
    if (typeof item !== 'object' || item === null) continue;
    const s = item as Record<string, unknown>;
    if (s.type === 'TextQuoteSelector') {
      if (typeof s.exact !== 'string' || s.exact.length === 0) continue;
      const sel: Selector = { type: 'TextQuoteSelector', exact: s.exact.slice(0, MAX_SELECTOR_TEXT) };
      if (typeof s.prefix === 'string') sel.prefix = s.prefix.slice(0, MAX_SELECTOR_TEXT);
      if (typeof s.suffix === 'string') sel.suffix = s.suffix.slice(0, MAX_SELECTOR_TEXT);
      out.push(sel);
    } else if (s.type === 'TextPositionSelector') {
      const start = s.start;
      const end = s.end;
      if (typeof start !== 'number' || typeof end !== 'number') continue;
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) continue;
      out.push({ type: 'TextPositionSelector', start, end });
    } else if (s.type === 'RangeSelector') {
      const sel: Selector = { type: 'RangeSelector' };
      if (typeof s.xpath === 'string') sel.xpath = s.xpath.slice(0, MAX_SELECTOR_TEXT);
      if (typeof s.startXpath === 'string') sel.startXpath = s.startXpath.slice(0, MAX_SELECTOR_TEXT);
      if (typeof s.endXpath === 'string') sel.endXpath = s.endXpath.slice(0, MAX_SELECTOR_TEXT);
      if (typeof s.startOffset === 'number' && Number.isInteger(s.startOffset)) sel.startOffset = s.startOffset;
      if (typeof s.endOffset === 'number' && Number.isInteger(s.endOffset)) sel.endOffset = s.endOffset;
      out.push(sel);
    }
  }
  if (out.length === 0 && opts.allowEmpty !== true) {
    return fail('invalid_target', '至少需要一个可用的 selector');
  }
  return { ok: true, value: out };
}

// ---------------------------------------------------------------------------
// 归属与可见性
// ---------------------------------------------------------------------------

/** 作者本人(按 GitHub 数字 id 判定,不看 login)。 */
export function isAuthor(record: { author: Author }, actor: Author): boolean {
  return record.author.githubId === actor.githubId;
}

/**
 * 版主:MODERATOR_LOGINS 白名单里的 login 可以**删除**任意公开批注。
 * 明确不给的事:版主不能看他人私有批注,也不能改他人(含公开)批注的内容 ——
 * 只保留「删除公开内容」这一项治理能力,取舍写在 README 与汇报里。
 */
export function isModerator(actor: Author, moderatorLogins: string[]): boolean {
  if (moderatorLogins.length === 0) return false;
  return moderatorLogins.includes(actor.login.toLowerCase());
}

/**
 * 可见性:public 任何人可读;private 只有作者本人可读。
 * 不可读一律由调用方回 **404**(不是 403)—— 对私有批注不泄露存在性。
 */
export function canRead(record: AnnotationRecord, actor: Author | null): boolean {
  if (record.visibility === 'public') return true;
  return actor !== null && isAuthor(record, actor);
}

/** 改内容:仅作者本人(版主也不行)。 */
export function canEdit(record: AnnotationRecord, actor: Author | null): boolean {
  return actor !== null && isAuthor(record, actor);
}

/** 删除:作者本人,或版主删公开批注。 */
export function canDelete(
  record: AnnotationRecord,
  actor: Author | null,
  moderatorLogins: string[],
): boolean {
  if (actor === null) return false;
  if (isAuthor(record, actor)) return true;
  return record.visibility === 'public' && isModerator(actor, moderatorLogins);
}

/** 列表可见性过滤(scope=public 匿名可读 / scope=mine 仅本人私有+公开)。 */
export function filterForScope(
  records: AnnotationRecord[],
  scope: 'public' | 'mine',
  actor: Author | null,
): AnnotationRecord[] {
  if (scope === 'public') return records.filter((r) => r.visibility === 'public');
  if (actor === null) return [];
  return records.filter((r) => isAuthor(r, actor));
}

// ---------------------------------------------------------------------------
// 回复合并
// ---------------------------------------------------------------------------

export interface MergeRepliesOptions {
  existing: Reply[];
  incoming: ReplyInput[];
  actor: Author;
  isAnnotationOwner: boolean;
  maxReplies: number;
  maxBodyChars: number;
  now: string;
  newId?: () => string;
}

/**
 * 把「客户端提交的回复数组」合并进已存回复。规则(全部为纯函数,便于单测):
 *  - 带 id 的条目必须在已存回复里存在,否则 reply_not_found;
 *  - 带 id 且作者不是自己 → reply_forbidden(批注作者也不能改写别人的话);
 *  - 已存回复没出现在提交数组里 = 删除,但只有「自己写的」或「批注作者」删得掉,
 *    否则原样保留(静默,不报错 —— 避免客户端因为看不见别人的回复而整个 PATCH 失败);
 *  - 不带 id 的条目 = 新回复,作者记当前登录身份;
 *  - 顺序以提交数组为准;总数超上限则 too_many_replies。
 */
export function mergeReplies(opts: MergeRepliesOptions): Validation<Reply[]> {
  const { existing, incoming, actor, isAnnotationOwner, maxReplies, maxBodyChars, now } = opts;
  const newId = opts.newId ?? (() => randomUUID());
  if (incoming.length > maxReplies) {
    return fail('too_many_replies', `回复数超过 ${maxReplies} 条上限`);
  }
  const byId = new Map(existing.map((r) => [r.id, r]));
  const kept = new Set<string>();
  const out: Reply[] = [];

  for (const item of incoming) {
    if (typeof item !== 'object' || item === null) return fail('invalid_reply', '回复格式不正确');
    const bodyResult = normalizeBody(item.body, maxBodyChars);
    if (!bodyResult.ok) return bodyResult;
    if (typeof item.id === 'string' && item.id.length > 0) {
      const prev = byId.get(item.id);
      if (prev === undefined) return fail('reply_not_found', '回复不存在或已被删除');
      if (prev.author.githubId !== actor.githubId) {
        return fail('reply_forbidden', '只能编辑自己的回复');
      }
      kept.add(prev.id);
      out.push({ ...prev, body: bodyResult.value, updatedAt: now });
    } else {
      let parentId: string | undefined;
      if (typeof item.parentId === 'string' && item.parentId.length > 0) {
        // 只认「已存的」或「这一批里刚收下的」—— 后者让「先回一层、再回那条新回复」
        // 在一次 PATCH 里也成立。指向不存在的楼层直接拒,免得列表里出现孤儿。
        const known = byId.has(item.parentId) || out.some((r) => r.id === item.parentId);
        if (!known) return fail('reply_not_found', '要回复的那条回复不存在');
        parentId = item.parentId;
      }
      const reply: Reply = {
        id: newId(),
        body: bodyResult.value,
        author: actor,
        createdAt: now,
        updatedAt: now,
      };
      if (parentId !== undefined) reply.parentId = parentId;
      out.push(reply);
    }
  }

  // 未被提交的旧回复:自己写的、或批注作者的批注 → 删除;其余原样保留。
  for (const prev of existing) {
    if (kept.has(prev.id)) continue;
    const submitted = incoming.some((i) => i.id === prev.id);
    if (submitted) continue;
    const mine = prev.author.githubId === actor.githubId;
    if (mine || isAnnotationOwner) continue; // 删除:不放进 out
    out.push(prev);
  }

  if (out.length > maxReplies) {
    return fail('too_many_replies', `回复数超过 ${maxReplies} 条上限`);
  }
  return { ok: true, value: out };
}

/**
 * 追加一条回复。
 *
 * 为什么不是复用 mergeReplies:PATCH 的 replies 是**整数组**语义、且只有批注作者
 * 能提交(改内容仅作者)。照那条路走,别人根本回不了你的批注 —— 而「回复」的定义
 * 就是别人回你。所以单开一条追加语义的路:任何能读到这条批注的登录用户都能追加。
 */
export function appendReply(opts: {
  existing: Reply[];
  body: string;
  parentId?: string;
  actor: Author;
  maxReplies: number;
  maxBodyChars: number;
  now: string;
  newId?: () => string;
}): Validation<Reply[]> {
  const { existing, actor, maxReplies, maxBodyChars, now } = opts;
  if (existing.length >= maxReplies) {
    return fail('too_many_replies', `回复数超过 ${maxReplies} 条上限`);
  }
  const body = normalizeBody(opts.body, maxBodyChars);
  if (!body.ok) return body;
  let parentId: string | undefined;
  if (opts.parentId !== undefined && opts.parentId !== '') {
    // 父回复必须已经存在。悬空的 parentId 会让前端渲染出一层没有出处的缩进。
    if (!existing.some((r) => r.id === opts.parentId)) {
      return fail('reply_not_found', '要回复的那条回复不存在');
    }
    parentId = opts.parentId;
  }
  const reply: Reply = {
    id: (opts.newId ?? randomUUID)(),
    body: body.value,
    author: actor,
    createdAt: now,
    updatedAt: now,
  };
  if (parentId !== undefined) reply.parentId = parentId;
  return { ok: true, value: [...existing, reply] };
}

/**
 * 删一条回复。回复作者本人可以删,批注作者也可以删(楼层楼主清理自己楼里的回复)。
 * 只删这一条,不级联删它下面的回复 —— 别人在它下面的发言不该被连带抹掉;
 * 前端把「找不到父级」的按顶层渲染(见 store.ts 的 Reply.parentId)。
 */
export function removeReply(
  existing: Reply[],
  replyId: string,
  actor: Author,
  isAnnotationOwner: boolean,
): Validation<Reply[]> {
  const target = existing.find((r) => r.id === replyId);
  if (target === undefined) return fail('reply_not_found', '回复不存在或已被删除');
  if (target.author.githubId !== actor.githubId && !isAnnotationOwner) {
    return fail('reply_forbidden', '只能删除自己的回复');
  }
  return { ok: true, value: existing.filter((r) => r.id !== replyId) };
}

// ---------------------------------------------------------------------------
// 点赞
// ---------------------------------------------------------------------------

/**
 * 点赞 / 取消点赞。**幂等**:已经赞过再赞、没赞过再取消,都返回原对象
 * (调用方可用 `next === record` 判断要不要落盘),这样客户端重试不会把计数点乱。
 *
 * likes 存 GitHub 数字 id 而不是 login(login 可改);不碰 updatedAt —— 点个赞
 * 不该让这条批注显示成「刚编辑过」。
 */
export function applyLike(
  record: AnnotationRecord,
  actor: Author,
  liked: boolean,
): AnnotationRecord {
  const has = record.likes.includes(actor.githubId);
  if (has === liked) return record;
  const likes = liked
    ? [...record.likes, actor.githubId]
    : record.likes.filter((id) => id !== actor.githubId);
  return { ...record, likes };
}

/**
 * 对外的批注形态。
 *
 * 原始记录里的 `likes` 是**点过赞的人的 GitHub id 列表** —— 直接返回等于公开
 * 「谁赞过」,既是隐私面(能看出谁读了哪一页)又没有展示价值。只回计数与
 * 「我赞过没」,点赞按钮据此渲染。
 */
export function toClientJson(
  record: AnnotationRecord,
  actor: Author | null,
): Omit<AnnotationRecord, 'likes'> & { likeCount: number; likedByMe: boolean } {
  const { likes, ...rest } = record;
  return {
    ...rest,
    likeCount: likes.length,
    likedByMe: actor !== null && likes.includes(actor.githubId),
  };
}

// ---------------------------------------------------------------------------
// 导出(hypothes.is JSON 兼容形态)
// ---------------------------------------------------------------------------

/**
 * 导出成 hypothes.is 的 JSON 形态(尽量兼容,不保证逐字段等价)。
 * 只导出调用方有权读的:公开批注 + 本人私有。
 */
export function toHypothesisExport(records: AnnotationRecord[], siteBase: string): unknown[] {
  return records.map((r) => ({
    id: r.id,
    uri: `${siteBase}${r.page}`,
    text: r.body,
    tags: [r.color],
    user: r.author.login,
    group: r.visibility === 'public' ? 'public' : `private:${r.author.githubId}`,
    created: r.createdAt,
    updated: r.updatedAt,
    // 全页评论按 W3C / hypothes.is 的 page note 惯例:target 只留 source,
    // **不带 selector 键**(塞空数组会被导入侧当成无效 target)。
    target: [
      r.target.scope === 'page'
        ? { source: `${siteBase}${r.page}` }
        : { source: `${siteBase}${r.page}`, selector: r.target.selectors },
    ],
    replies: r.replies.map((reply) => ({
      id: reply.id,
      text: reply.body,
      user: reply.author.login,
      created: reply.createdAt,
      updated: reply.updatedAt,
    })),
  }));
}

export function newAnnotationId(): string {
  return randomUUID();
}
