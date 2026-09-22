/**
 * HTTP 服务(node:http,无框架)。
 *
 * 路由:
 *   GET    /healthz
 *   GET    /api/auth/github/start?return=     302 → GitHub 授权页
 *   GET    /api/auth/github/callback?code=&state=  换 token → 建会话 → 302 回站点
 *   POST   /api/auth/session                  {code} 一次性 code 换 bearer token
 *   GET    /api/auth/me                       当前用户(未登录 401)
 *   POST   /api/auth/logout                   吊销会话
 *   POST   /api/auth/dev                      仅回环 + DEV_AUTH_BYPASS 时可用,直接发 token
 *   GET    /api/annotations?page=&scope=      scope=public 匿名可读 / scope=mine 需登录
 *   POST   /api/annotations                   需登录;body.visibility: public|private
 *   POST   /api/annotations/:id/replies       需登录;任何能读到这条批注的人都能回
 *   DELETE /api/annotations/:id/replies/:rid  回复作者,或批注作者
 *   PUT    /api/annotations/:id/like          需登录;幂等
 *   DELETE /api/annotations/:id/like          需登录;幂等
 *   PATCH  /api/annotations/:id               需登录 + 仅作者
 *   DELETE /api/annotations/:id               需登录 + 仅作者(版主可删公开)
 *   GET    /api/annotations/export?page=      hypothes.is JSON 兼容导出
 *   POST   /api/highlight/suggest             不要求登录,靠限流与防滥用兜底
 *
 * 鉴权走 `Authorization: Bearer <token>`,**不用 Cookie**(站点与后端跨源,
 * 第三方 Cookie 会被浏览器拦)。日志不含原始 IP 与明文 token。
 */
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { AnnotationStore } from './store.ts';
import type { AnnotationRecord, Author } from './store.ts';
import { AuthService, sanitizeReturn } from './auth.ts';
import { canonicalPage } from './index-store.ts';
import type { IndexLike } from './index-store.ts';
import { PageTextIndex } from './index-store.ts';
import {
  appendReply,
  applyLike,
  canDelete,
  canEdit,
  canRead,
  filterForScope,
  mergeReplies,
  newAnnotationId,
  normalizeBody,
  normalizeColor,
  normalizeSelectors,
  normalizeStyle,
  normalizeVisibility,
  removeReply,
  toClientJson,
  toHypothesisExport,
} from './annotations.ts';
import type { ReplyInput } from './annotations.ts';
import { hashIp, SlidingWindowLimiter } from './rate-limit.ts';
import { JevJudge } from './highlight/jev-provider.ts';
import { LlmJudge } from './highlight/llm-provider.ts';
import { HighlightService, normalizeJudgeBlocks, normalizePalette } from './highlight/index.ts';
import type { HighlightRequest } from './highlight/index.ts';

const CreateAnnotationSchema = z.object({
  page: z.string().min(1).max(512),
  // 空正文合法:纯高亮没有文字(见 normalizeBody 的 allowEmpty)
  body: z.string().max(20_000),
  color: z.string().min(1).max(32),
  // 画法。可选:不带按 highlight 处理(与这个字段存在之前的行为一致)
  style: z.string().optional(),
  visibility: z.string(),
  // selectors 默认允许空数组,但「空」只对显式声明 scope:'page' 的全页评论合法 ——
  // 这道 refine 把「忘了带锚点」与「就是要整页评论」分开,见 normalizeSelectors。
  target: z
    .object({
      selectors: z.array(z.unknown()).default([]),
      scope: z.literal('page').optional(),
    })
    .passthrough()
    .refine((t) => t.selectors.length > 0 || t.scope === 'page', {
      message: "selectors 为空时必须带 scope: 'page'(全页评论)",
    }),
});

const PatchAnnotationSchema = z.object({
  body: z.string().optional(),
  color: z.string().optional(),
  style: z.string().optional(),
  visibility: z.string().optional(),
  replies: z
    .array(
      z
        .object({ id: z.string().optional(), body: z.string(), parentId: z.string().optional() })
        .passthrough(),
    )
    .optional(),
});

const ReplyCreateSchema = z.object({
  body: z.string(),
  parentId: z.string().optional(),
});

const SuggestSchema = z.object({
  page: z.string().min(1).max(512),
  title: z.string().max(300).default(''),
  palette: z.array(z.unknown()).default([]),
  blocks: z.array(z.unknown()).default([]),
  judge: z.enum(['auto', 'jev', 'llm']).default('auto'),
});

interface ServerDeps {
  config: Config;
  store: AnnotationStore;
  auth: AuthService;
  index: IndexLike;
  highlight: HighlightService;
}

export function createApp(deps: ServerDeps) {
  const { config, store, auth, index, highlight } = deps;
  const limiter = new SlidingWindowLimiter(config.rateLimitMax, config.rateLimitWindowMs);
  // 每账号写入配额:批注是写入型接口,按账号计比按 IP 准(同一 NAT 后的人不互相挤)
  const writeQuota = new SlidingWindowLimiter(config.writeQuotaMax, config.writeQuotaWindowMs);
  const startedAt = Date.now();

  function originAllowed(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return config.allowedOrigins.includes(origin);
  }

  function corsHeadersFor(origin: string | undefined): Record<string, string> {
    const headers: Record<string, string> = { Vary: 'Origin' };
    if (origin !== undefined && config.allowedOrigins.includes(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      // Retry-After 不在 CORS 安全清单里,不显式 expose 的话前端读不到它
      // (跨源 fetch 只能看到 safelisted 响应头)。读不到就只能退化成写死的
      // 冷却秒数,而 429 的真实窗口是 10 分钟 —— 冷却会在窗口结束前到期,
      // 用户按提示重试仍旧撞 429。
      headers['Access-Control-Expose-Headers'] = 'Retry-After';
    }
    return headers;
  }

  let warnedUntrustedProxy = false;

  function clientIp(req: IncomingMessage): string {
    if (config.trustProxy && config.trustedProxyIps.includes(req.socket.remoteAddress ?? '')) {
      // 顺序要紧:本服务部署在 Cloudflare 隧道后面,`cf-connecting-ip` 由 CF 覆写、
      // 客户端伪造不了;而 `fly-client-ip` 是 Fly.io 的头,CF **不会**碰它,客户端
      // 自己发什么就透传什么 —— 放在前面等于给每个请求一个可自选的限流桶。
      // 保留它只为万一换到 Fly 部署(那时 cf-connecting-ip 不存在,自然落到它)。
      for (const header of ['cf-connecting-ip', 'fly-client-ip'] as const) {
        const forwarded = req.headers[header];
        if (typeof forwarded === 'string' && forwarded.length > 0) {
          return forwarded.split(',')[0]!.trim();
        }
      }
    } else if (config.trustProxy && !warnedUntrustedProxy) {
      warnedUntrustedProxy = true;
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'untrusted_proxy_ignored',
          hint: 'TRUST_PROXY=true 但远端地址不在 TRUSTED_PROXY_IPS,已忽略转发头',
        }),
      );
    }
    return req.socket.remoteAddress ?? 'unknown';
  }

  function safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return timingSafeEqual(ab, bb);
  }

  function writeJson(
    res: ServerResponse,
    status: number,
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): void {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      Vary: 'Origin',
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  }

  function sendError(
    req: IncomingMessage,
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
    extraHeaders: Record<string, string> = {},
  ): void {
    const requestId = req.headers['x-request-id'] ?? randomUUID();
    writeJson(res, status, { error: code, message, requestId }, extraHeaders);
  }

  function bearerToken(req: IncomingMessage): string | null {
    const raw = req.headers.authorization;
    if (typeof raw !== 'string') return null;
    const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
    return match === null ? null : match[1]!.trim();
  }

  /** 读取并解析 JSON 请求体;失败返回 null 并已写好响应。 */
  async function readJson(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Promise<unknown | null> {
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if (contentLength > config.bodyLimitBytes) {
      sendError(req, res, 413, 'payload_too_large', '请求体超限', cors);
      res.socket?.destroySoon();
      return null;
    }
    let body = '';
    let overLimit = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      req.destroy();
    }, config.bodyTimeoutMs);
    try {
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > config.bodyLimitBytes) {
          overLimit = true;
          break;
        }
      }
    } catch {
      clearTimeout(timer);
      sendError(
        req,
        res,
        timedOut ? 408 : 400,
        timedOut ? 'request_timeout' : 'bad_request',
        timedOut ? '读取请求体超时' : '读取请求体失败',
        cors,
      );
      return null;
    }
    clearTimeout(timer);
    if (overLimit) {
      sendError(req, res, 413, 'payload_too_large', '请求体超限', cors);
      res.socket?.destroySoon();
      return null;
    }
    if (body.length === 0) return {};
    try {
      return JSON.parse(body);
    } catch {
      sendError(req, res, 400, 'bad_request', '请求体不是合法 JSON', cors);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // 鉴权与限流前置
  // -------------------------------------------------------------------------

  /** 返回当前登录身份(未登录为 null);顺带做 Origin / API Key 前置校验。 */
  function authenticate(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
  ): Author | null | 'rejected' {
    const origin = req.headers.origin;
    if (origin !== undefined && !originAllowed(origin)) {
      sendError(req, res, 403, 'forbidden', 'Origin 不在白名单', { Vary: 'Origin' });
      return 'rejected';
    }
    const apiKeyHeader = req.headers['x-api-key'];
    if (
      config.apiKey &&
      origin === undefined &&
      !safeEqual(typeof apiKeyHeader === 'string' ? apiKeyHeader : '', config.apiKey)
    ) {
      sendError(req, res, 401, 'unauthorized', '缺少或错误的 X-API-Key', cors);
      return 'rejected';
    }
    return auth.verify(bearerToken(req));
  }

  function requireLogin(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Author | null {
    if (actor === 'rejected') return null;
    if (actor === null) {
      sendError(req, res, 401, 'login_required', '该操作需要登录', cors);
      return null;
    }
    return actor;
  }

  // -------------------------------------------------------------------------
  // 批注
  // -------------------------------------------------------------------------

  function annotationsOf(page: string): AnnotationRecord[] {
    return store.annotations.filter((a) => a.page === page);
  }

  async function handleListAnnotations(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    if (actor === 'rejected') return;
    const page = canonicalPage(url.searchParams.get('page') ?? '');
    if (page === null) {
      sendError(req, res, 400, 'invalid_page', 'page 必须是本站路径', cors);
      return;
    }
    const scope = url.searchParams.get('scope') ?? 'public';
    if (scope !== 'public' && scope !== 'mine') {
      sendError(req, res, 400, 'invalid_scope', 'scope 只能是 public 或 mine', cors);
      return;
    }
    if (scope === 'mine' && actor === null) {
      sendError(req, res, 401, 'login_required', '查看自己的批注需要登录', cors);
      return;
    }
    const visible = filterForScope(annotationsOf(page), scope, actor);
    writeJson(
      res,
      200,
      { page, scope, annotations: visible.map((a) => toClientJson(a, actor)) },
      cors,
    );
  }

  async function handleCreateAnnotation(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const json = await readJson(req, res, cors);
    if (json === null) return;

    const parsed = CreateAnnotationSchema.safeParse(json);
    if (!parsed.success) {
      sendError(req, res, 400, 'bad_request', '请求体格式不正确', cors);
      return;
    }
    const page = canonicalPage(parsed.data.page);
    if (page === null) {
      sendError(req, res, 400, 'invalid_page', 'page 必须是本站路径', cors);
      return;
    }
    // allowEmpty:纯高亮(没有文字)是合法批注 —— 智能高亮的产出就是这个形态
    const body = normalizeBody(parsed.data.body, config.maxBodyChars, true);
    if (!body.ok) {
      sendError(req, res, 400, body.code, body.detail, cors);
      return;
    }
    const color = normalizeColor(parsed.data.color);
    if (!color.ok) {
      sendError(req, res, 400, color.code, color.detail, cors);
      return;
    }
    const visibility = normalizeVisibility(parsed.data.visibility);
    if (!visibility.ok) {
      sendError(req, res, 400, visibility.code, visibility.detail, cors);
      return;
    }
    const style = normalizeStyle(parsed.data.style);
    if (!style.ok) {
      sendError(req, res, 400, style.code, style.detail, cors);
      return;
    }
    const pageScope = parsed.data.target.scope === 'page' ? ('page' as const) : undefined;
    const selectors = normalizeSelectors(parsed.data.target.selectors, {
      allowEmpty: pageScope === 'page',
    });
    if (!selectors.ok) {
      sendError(req, res, 400, selectors.code, selectors.detail, cors);
      return;
    }
    if (store.annotations.length >= config.maxAnnotations) {
      sendError(req, res, 507, 'storage_full', '批注存储已达容量上限', cors);
      return;
    }
    if (annotationsOf(page).length >= config.maxAnnotationsPerPage) {
      sendError(req, res, 507, 'page_full', '该页批注数已达上限', cors);
      return;
    }
    if (!writeQuota.tryAcquire(`u${user.githubId}`)) {
      sendError(req, res, 429, 'write_quota', '写入过于频繁,请稍后再试', {
        'Retry-After': String(writeQuota.retryAfterSec()),
        ...cors,
      });
      return;
    }

    const now = new Date().toISOString();
    const record: AnnotationRecord = {
      id: newAnnotationId(),
      page,
      visibility: visibility.value,
      color: color.value,
      style: style.value,
      body: body.value,
      author: user,
      target: pageScope === undefined
        ? { selectors: selectors.value }
        : { selectors: selectors.value, scope: pageScope },
      replies: [],
      likes: [],
      createdAt: now,
      updatedAt: now,
    };
    store.setAnnotations([...store.annotations, record]);
    await store.flush();
    writeJson(res, 201, { annotation: toClientJson(record, user) }, cors);
  }

  async function handlePatchAnnotation(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const record = store.annotations.find((a) => a.id === id);
    // 无权读的记录一律 404(不泄露私有批注的存在性);有权读但无权改才是 403
    if (record === undefined || !canRead(record, user)) {
      sendError(req, res, 404, 'not_found', '批注不存在', cors);
      return;
    }
    if (!canEdit(record, user)) {
      sendError(req, res, 403, 'forbidden', '只有作者本人可以修改', cors);
      return;
    }
    const json = await readJson(req, res, cors);
    if (json === null) return;
    const parsed = PatchAnnotationSchema.safeParse(json);
    if (!parsed.success) {
      sendError(req, res, 400, 'bad_request', '请求体格式不正确', cors);
      return;
    }

    const next: AnnotationRecord = { ...record };
    if (parsed.data.body !== undefined) {
      const body = normalizeBody(parsed.data.body, config.maxBodyChars, true);
      if (!body.ok) {
        sendError(req, res, 400, body.code, body.detail, cors);
        return;
      }
      next.body = body.value;
    }
    if (parsed.data.color !== undefined) {
      const color = normalizeColor(parsed.data.color);
      if (!color.ok) {
        sendError(req, res, 400, color.code, color.detail, cors);
        return;
      }
      next.color = color.value;
    }
    if (parsed.data.style !== undefined) {
      const style = normalizeStyle(parsed.data.style);
      if (!style.ok) {
        sendError(req, res, 400, style.code, style.detail, cors);
        return;
      }
      next.style = style.value;
    }
    if (parsed.data.visibility !== undefined) {
      const visibility = normalizeVisibility(parsed.data.visibility);
      if (!visibility.ok) {
        sendError(req, res, 400, visibility.code, visibility.detail, cors);
        return;
      }
      next.visibility = visibility.value;
    }
    if (parsed.data.replies !== undefined) {
      const merged = mergeReplies({
        existing: record.replies,
        incoming: parsed.data.replies as ReplyInput[],
        actor: user,
        isAnnotationOwner: true,
        maxReplies: config.maxRepliesPerAnnotation,
        maxBodyChars: config.maxBodyChars,
        now: new Date().toISOString(),
      });
      if (!merged.ok) {
        sendError(req, res, merged.code === 'reply_forbidden' ? 403 : 400, merged.code, merged.detail, cors);
        return;
      }
      next.replies = merged.value;
    }
    next.updatedAt = new Date().toISOString();

    store.setAnnotations(store.annotations.map((a) => (a.id === id ? next : a)));
    await store.flush();
    writeJson(res, 200, { annotation: toClientJson(next, user) }, cors);
  }

  /**
   * 追加一条回复。与 PATCH 的整数组 replies **不是一回事**:那条只有批注作者能提交
   * (改内容仅作者),而回复天生是别人来回你的 —— 照那条路走,别人根本回不了。
   */
  async function handleCreateReply(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const record = store.annotations.find((a) => a.id === id);
    if (record === undefined || !canRead(record, user)) {
      sendError(req, res, 404, 'not_found', '批注不存在', cors);
      return;
    }
    const json = await readJson(req, res, cors);
    if (json === null) return;
    const parsed = ReplyCreateSchema.safeParse(json);
    if (!parsed.success) {
      sendError(req, res, 400, 'bad_request', '请求体格式不正确', cors);
      return;
    }
    const merged = appendReply({
      existing: record.replies,
      body: parsed.data.body,
      parentId: parsed.data.parentId,
      actor: user,
      maxReplies: config.maxRepliesPerAnnotation,
      maxBodyChars: config.maxBodyChars,
      now: new Date().toISOString(),
    });
    if (!merged.ok) {
      sendError(req, res, 400, merged.code, merged.detail, cors);
      return;
    }
    const next: AnnotationRecord = { ...record, replies: merged.value };
    store.setAnnotations(store.annotations.map((a) => (a.id === id ? next : a)));
    await store.flush();
    writeJson(res, 201, { annotation: toClientJson(next, user) }, cors);
  }

  async function handleDeleteReply(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    replyId: string,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const record = store.annotations.find((a) => a.id === id);
    if (record === undefined || !canRead(record, user)) {
      sendError(req, res, 404, 'not_found', '批注不存在', cors);
      return;
    }
    const removed = removeReply(record.replies, replyId, user, canEdit(record, user));
    if (!removed.ok) {
      sendError(req, res, removed.code === 'reply_forbidden' ? 403 : 404, removed.code, removed.detail, cors);
      return;
    }
    const next: AnnotationRecord = { ...record, replies: removed.value };
    store.setAnnotations(store.annotations.map((a) => (a.id === id ? next : a)));
    await store.flush();
    writeJson(res, 200, { annotation: toClientJson(next, user) }, cors);
  }

  /**
   * 点赞 / 取消点赞。幂等:重复 PUT 或重复 DELETE 都成功,不报错也不重复计数 ——
   * 客户端重试与连点都不必自己做去重。
   *
   * 与读权限同规矩:读不到的一律 404(私有批注不泄露存在性)。**不做「只能赞
   * 公开批注」的限制** —— 私有批注只有作者本人读得到,他赞自己的笔记无害,
   * 而多一条特例就多一处要解释、要测的规则。
   */
  async function handleLikeAnnotation(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    liked: boolean,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const record = store.annotations.find((a) => a.id === id);
    if (record === undefined || !canRead(record, user)) {
      sendError(req, res, 404, 'not_found', '批注不存在', cors);
      return;
    }
    const next = applyLike(record, user, liked);
    if (next !== record) {
      store.setAnnotations(store.annotations.map((a) => (a.id === id ? next : a)));
      await store.flush();
    }
    writeJson(res, 200, { annotation: toClientJson(next, user) }, cors);
  }

  async function handleDeleteAnnotation(
    req: IncomingMessage,
    res: ServerResponse,
    id: string,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    const user = requireLogin(req, res, cors, actor);
    if (user === null) return;
    const record = store.annotations.find((a) => a.id === id);
    if (record === undefined || !canRead(record, user)) {
      sendError(req, res, 404, 'not_found', '批注不存在', cors);
      return;
    }
    if (!canDelete(record, user, config.moderatorLogins)) {
      sendError(req, res, 403, 'forbidden', '只有作者本人可以删除', cors);
      return;
    }
    store.setAnnotations(store.annotations.filter((a) => a.id !== id));
    await store.flush();
    writeJson(res, 200, { deleted: id }, cors);
  }

  function handleExport(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): void {
    if (actor === 'rejected') return;
    const page = canonicalPage(url.searchParams.get('page') ?? '');
    if (page === null) {
      sendError(req, res, 400, 'invalid_page', 'page 必须是本站路径', cors);
      return;
    }
    const user = actor;
    const visible = filterForScope(annotationsOf(page), 'public', null);
    const mine = user === null ? [] : annotationsOf(page).filter((a) => a.author.githubId === user.githubId);
    const all = [...visible, ...mine.filter((a) => a.visibility === 'private')];
    writeJson(res, 200, toHypothesisExport(all, config.siteBase), {
      ...cors,
      'Content-Disposition': 'attachment; filename="annotations.json"',
    });
  }

  // -------------------------------------------------------------------------
  // 智能高亮
  // -------------------------------------------------------------------------

  async function handleSuggest(
    req: IncomingMessage,
    res: ServerResponse,
    cors: Record<string, string>,
    actor: Author | null | 'rejected',
  ): Promise<void> {
    if (actor === 'rejected') return;
    const json = await readJson(req, res, cors);
    if (json === null) return;
    const parsed = SuggestSchema.safeParse(json);
    if (!parsed.success) {
      sendError(req, res, 400, 'bad_request', '请求体格式不正确', cors);
      return;
    }
    const request: HighlightRequest = {
      page: parsed.data.page,
      title: parsed.data.title,
      palette: normalizePalette(parsed.data.palette),
      blocks: normalizeJudgeBlocks(parsed.data.blocks),
      judge: parsed.data.judge,
    };
    const ipKey = hashIp(clientIp(req));
    const controller = new AbortController();
    res.once('close', () => {
      if (!res.writableEnded) controller.abort();
    });
    const result = await highlight.suggest(request, ipKey, controller.signal);
    if (result.ok) {
      writeJson(res, 200, result.body, cors);
      return;
    }
    if (result.status === 499) return; // 客户端已断开
    const headers: Record<string, string> = { ...cors };
    if (result.retryAfterSec !== undefined) headers['Retry-After'] = String(result.retryAfterSec);
    sendError(req, res, result.status, result.code, result.message, headers);
  }

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const url = new URL(rawUrl, `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const origin = req.headers.origin;
    const cors = corsHeadersFor(origin);

    const fail = (err: unknown) => {
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'handler_crash',
          path,
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      try {
        res.destroy();
      } catch {
        /* 连接已不可用 */
      }
    };

    if (method === 'OPTIONS') {
      if (!originAllowed(origin)) {
        sendError(req, res, 403, 'forbidden', 'Origin 不在白名单');
        return;
      }
      const headers: Record<string, string> = { Vary: 'Origin', 'Content-Length': '0' };
      if (origin !== undefined) {
        headers['Access-Control-Allow-Origin'] = origin;
        // PUT 是点赞要用的;漏一个方法,预检就把整个请求挡在门外,页面只看到
        // 一个 status 0,排查时完全不指向这里
        headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
        // Authorization 与 X-API-Key 必须显式放行,否则跨源请求连预检都过不去
        headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key';
        headers['Access-Control-Max-Age'] = '86400';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    if (method === 'GET' && path === '/healthz') {
      const stats = index.getStats();
      writeJson(res, 200, {
        ok: true,
        indexPages: stats.pageCount,
        indexStale: stats.stale,
        lastIndexLoadedAt: stats.lastLoadedAt,
        annotations: store.annotations.length,
        sessions: store.sessions.length,
        storeError: store.lastError,
        concurrencyActive: highlight.semaphore.activeCount,
        concurrencyWaiting: highlight.semaphore.waitingCount,
        uptimeSec: Math.round((Date.now() - startedAt) / 1000),
        highlight: highlight.healthSnapshot(),
      });
      return;
    }

    // ---- 登录 ----
    if (method === 'GET' && path === '/api/auth/github/start') {
      const target = sanitizeReturn(
        url.searchParams.get('return'),
        config.returnOrigins,
        config.siteBase,
      );
      if (target === null) {
        sendError(req, res, 400, 'invalid_return', 'return 不在白名单内', cors);
        return;
      }
      if (!originAllowed(origin)) {
        sendError(req, res, 403, 'forbidden', 'Origin 不在白名单', { Vary: 'Origin' });
        return;
      }
      if (config.githubClientId.length === 0) {
        sendError(req, res, 503, 'auth_unavailable', '本服务未配置 GitHub OAuth', cors);
        return;
      }
      res.writeHead(302, { Location: auth.start(target), 'Cache-Control': 'no-store' });
      res.end();
      return;
    }

    if (method === 'GET' && path === '/api/auth/github/callback') {
      void auth
        .callback(url.searchParams.get('code') ?? undefined, url.searchParams.get('state') ?? undefined)
        .then((result) => {
          if (!result.ok) {
            sendError(req, res, 400, result.code, result.detail, { Vary: 'Origin' });
            return;
          }
          const target = new URL(result.returnTo);
          target.searchParams.set('aipm_auth_code', result.authCode);
          res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
          res.end();
        })
        .catch(fail);
      return;
    }

    if (method === 'POST' && path === '/api/auth/session') {
      if (!originAllowed(origin)) {
        sendError(req, res, 403, 'forbidden', 'Origin 不在白名单', { Vary: 'Origin' });
        return;
      }
      void readJson(req, res, cors)
        .then((json) => {
          if (json === null) return;
          const code = (json as { code?: unknown }).code;
          if (typeof code !== 'string' || code.length === 0) {
            sendError(req, res, 400, 'invalid_code', '缺少一次性 code', cors);
            return;
          }
          const redeemed = auth.redeemAuthCode(code);
          if (redeemed === null) {
            // 过期 / 已用过 / 不存在,统一 400(不区分,避免探测)
            sendError(req, res, 400, 'invalid_code', 'code 无效或已过期', cors);
            return;
          }
          writeJson(res, 200, { token: redeemed.token, user: redeemed.user }, cors);
        })
        .catch(fail);
      return;
    }

    if (method === 'POST' && path === '/api/auth/dev') {
      // 仅回环 + 显式开启时 config.devAuthBypass 才为 true(见 config.ts)
      if (!config.devAuthBypass) {
        sendError(req, res, 404, 'not_found', 'Not Found', { Vary: 'Origin' });
        return;
      }
      // 带上 CORS 头:本地联调时前端要从**页面里**调它换会话(真实 OAuth 要注册
      // App + 隧道,本地跑不起来)。只反射 ALLOWED_ORIGINS 里的 origin —— 别的站点
      // 依旧拿不到响应,而能直连回环的人本来就能用 curl 拿到同一个会话。
      const session = auth.devLogin();
      void store.flush().then(() => writeJson(res, 200, session, cors));
      return;
    }

    if (method === 'GET' && path === '/api/auth/me') {
      const actor = authenticate(req, res, cors);
      if (actor === 'rejected') return;
      if (actor === null) {
        sendError(req, res, 401, 'login_required', '未登录', cors);
        return;
      }
      writeJson(res, 200, { user: actor }, cors);
      return;
    }

    if (method === 'POST' && path === '/api/auth/logout') {
      const actor = authenticate(req, res, cors);
      if (actor === 'rejected') return;
      void auth.revoke(bearerToken(req)).then((revoked) => {
        writeJson(res, 200, { revoked }, cors);
      });
      return;
    }

    // ---- 批注 ----
    if (path === '/api/annotations/export' && method === 'GET') {
      handleExport(req, res, url, cors, authenticate(req, res, cors));
      return;
    }

    if (path === '/api/annotations') {
      if (method === 'GET') {
        void handleListAnnotations(req, res, url, cors, authenticate(req, res, cors)).catch(fail);
        return;
      }
      if (method === 'POST') {
        if (!limiter.tryAcquire(hashIp(clientIp(req)))) {
          const headers = { 'Retry-After': String(limiter.retryAfterSec()), ...cors };
          sendError(req, res, 429, 'rate_limited', '请求过于频繁,请稍后再试', headers);
          return;
        }
        void handleCreateAnnotation(req, res, cors, authenticate(req, res, cors)).catch(fail);
        return;
      }
    }

    const annotationMatch = /^\/api\/annotations\/([^/]+)$/.exec(path);
    if (annotationMatch !== null) {
      const id = decodeURIComponent(annotationMatch[1]!);
      if (method === 'PATCH') {
        void handlePatchAnnotation(req, res, id, cors, authenticate(req, res, cors)).catch(fail);
        return;
      }
      if (method === 'DELETE') {
        void handleDeleteAnnotation(req, res, id, cors, authenticate(req, res, cors)).catch(fail);
        return;
      }
      if (method === 'GET') {
        // 单条读取:无权读一律 404
        const actor = authenticate(req, res, cors);
        if (actor === 'rejected') return;
        const record = store.annotations.find((a) => a.id === id);
        if (record === undefined || !canRead(record, actor)) {
          sendError(req, res, 404, 'not_found', '批注不存在', cors);
          return;
        }
        writeJson(res, 200, { annotation: toClientJson(record, actor) }, cors);
        return;
      }
    }

    const replyMatch = /^\/api\/annotations\/([^/]+)\/replies$/.exec(path);
    if (replyMatch !== null && method === 'POST') {
      const id = decodeURIComponent(replyMatch[1]!);
      void handleCreateReply(req, res, id, cors, authenticate(req, res, cors)).catch(fail);
      return;
    }

    const replyOneMatch = /^\/api\/annotations\/([^/]+)\/replies\/([^/]+)$/.exec(path);
    if (replyOneMatch !== null && method === 'DELETE') {
      const id = decodeURIComponent(replyOneMatch[1]!);
      const replyId = decodeURIComponent(replyOneMatch[2]!);
      void handleDeleteReply(req, res, id, replyId, cors, authenticate(req, res, cors)).catch(fail);
      return;
    }

    const likeMatch = /^\/api\/annotations\/([^/]+)\/like$/.exec(path);
    if (likeMatch !== null && (method === 'PUT' || method === 'DELETE')) {
      const id = decodeURIComponent(likeMatch[1]!);
      void handleLikeAnnotation(
        req,
        res,
        id,
        method === 'PUT',
        cors,
        authenticate(req, res, cors),
      ).catch(fail);
      return;
    }

    // ---- 智能高亮 ----
    if (method === 'POST' && path === '/api/highlight/suggest') {
      void handleSuggest(req, res, cors, authenticate(req, res, cors)).catch(fail);
      return;
    }

    sendError(req, res, 404, 'not_found', 'Not Found', { Vary: 'Origin' });
  });

  return { server, limiter, writeQuota };
}

async function main(): Promise<void> {
  if (existsSync('.env')) process.loadEnvFile('.env');
  const config = loadConfig();

  const store = new AnnotationStore(config.dataDir);
  const loaded = await store.load();
  console.log(
    `[server] 存储加载: ${store.path} (批注 ${loaded.annotations} 条,会话 ${loaded.sessions} 条` +
      `${loaded.dropped > 0 ? `,丢弃损坏记录 ${loaded.dropped} 条` : ''})`,
  );

  const index = new PageTextIndex(config.searchIndexUrl, config.indexRefreshMs);
  console.log(`[server] 加载站内索引: ${config.searchIndexUrl}`);
  await index.load();
  index.startAutoRefresh();

  const auth = new AuthService(config, store);
  const highlight = new HighlightService({
    config,
    index,
    judges: {
      jev: new JevJudge({
        apiKey: config.highlight.jevApiKey,
        baseUrl: config.highlight.jevBaseUrl,
        model: config.highlight.jevModel,
        timeoutMs: config.highlight.jevTimeoutMs,
      }),
      llm: new LlmJudge({
        apiKey: config.highlight.llmApiKey,
        model: config.highlight.llmModel,
        maxTokens: config.highlight.llmMaxTokens,
        timeoutMs: config.highlight.llmTimeoutMs,
        baseUrl: config.highlight.llmBaseUrl,
        mode: config.highlight.llmMode,
        inputCostPerMtok: config.highlight.llmInputCostPerMtok,
        outputCostPerMtok: config.highlight.llmOutputCostPerMtok,
      }),
    },
  });

  const { server } = createApp({ config, store, auth, index, highlight });
  server.listen(config.port, config.host, () => {
    console.log(
      `[server] 就绪: http://${config.host}:${config.port}  ` +
        `(index=${index.getStats().pageCount} 页, judge(主)=${config.highlight.primary}, ` +
        `回退=${config.highlight.fallback}` +
        `${config.highlight.fallback === 'llm' ? `(llm:${config.highlight.llmMode}@${config.highlight.llmBaseUrl || 'api.anthropic.com'})` : ''}` +
        `, 日预算=$ ${config.highlight.dailyBudgetUsd}` +
        `${config.devAuthBypass ? ', DEV_AUTH_BYPASS=on' : ''})`,
    );
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    index.stop();
    void store.flush().finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const entry = process.argv[1] ?? '';
if (entry.endsWith('server.ts') || entry.endsWith('dist/server.js')) {
  void main().catch((err) => {
    console.error(`[server] 启动失败: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
}
