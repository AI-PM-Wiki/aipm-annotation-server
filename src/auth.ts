/**
 * GitHub OAuth(Web Application Flow)+ 会话。
 *
 * 为什么不用 Cookie:站点(aipm.ac)与批注服务(anno-api.*)是**跨源**的,
 * 跨站 Cookie 会被 Safari ITP / Chrome 第三方 Cookie 策略拦掉。所以会话是
 * 服务端签发的**不透明 bearer token**,前端存 localStorage、请求带 Authorization。
 *
 * 三条硬约束:
 *  1. client_secret 只在服务端出现,永不进 URL / 日志 / 响应体。
 *  2. GitHub 回跳用**一次性 code + state**:state 防 CSRF(10 分钟、单次),
 *     `aipm_auth_code` 只活 60 秒且单次消费 —— 于是 token 不会出现在 URL、
 *     浏览器历史或任何日志里。
 *  3. token 明文只在签发那一刻回给客户端一次,服务端只留 sha256。
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Config } from './config.ts';
import type { Author, SessionRecord } from './store.ts';
import type { AnnotationStore } from './store.ts';

export interface GithubUser {
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
}

interface OAuthStateRecord {
  state: string;
  returnTo: string;
  expiresAt: number;
}

interface AuthCodeRecord {
  code: string;
  token: string;
  expiresAt: number;
}

export type CallbackResult =
  | { ok: true; returnTo: string; authCode: string }
  | { ok: false; code: string; detail: string };

export const SESSION_TOKEN_BYTES = 32; // 256 bit

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * `return` 白名单校验(开放重定向防护)。前端固定传 `location.href`:
 *  - 本站站点来源(在 RETURN_ORIGINS 里)的绝对 URL → 原样返回;
 *  - 相对路径(`/ai/rag/`)→ 拼到 SITE_BASE 上(便于脚本/测试只给路径);
 *  - 其余一律拒绝(协议相对 `//evil.com`、站外 origin、非 http(s) 协议)。
 * 空值回落到站点根。
 */
export function sanitizeReturn(
  raw: string | undefined | null,
  returnOrigins: string[],
  siteBase: string,
): string | null {
  const root = `${siteBase.replace(/\/+$/, '')}/`;
  if (raw === undefined || raw === null || raw.trim().length === 0) return root;
  const value = raw.trim();
  if (value.length > 2_048) return null;
  if (value.startsWith('/')) {
    if (value.startsWith('//')) return null;
    if (value.includes('\\')) return null;
    try {
      return new URL(value, root).toString();
    } catch {
      return null;
    }
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!returnOrigins.includes(url.origin)) return null;
  return url.toString();
}

/** 会话记录 → 作者身份(展示用快照)。 */
export function authorFromSession(session: SessionRecord): Author {
  const author: Author = { githubId: session.githubId, login: session.login };
  if (session.name !== undefined) author.name = session.name;
  if (session.avatarUrl !== undefined) author.avatarUrl = session.avatarUrl;
  return author;
}

export interface AuthServiceDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  randomToken?: () => string;
}

export class AuthService {
  private readonly config: Config;
  private readonly store: AnnotationStore;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly randomToken: () => string;
  private readonly states = new Map<string, OAuthStateRecord>();
  private readonly codes = new Map<string, AuthCodeRecord>();

  constructor(config: Config, store: AnnotationStore, deps: AuthServiceDeps = {}) {
    this.config = config;
    this.store = store;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? (() => Date.now());
    this.randomToken = deps.randomToken ?? (() => randomBytes(SESSION_TOKEN_BYTES).toString('base64url'));
  }

  private prune(): void {
    const now = this.now();
    for (const [k, v] of this.states) if (v.expiresAt <= now) this.states.delete(k);
    for (const [k, v] of this.codes) if (v.expiresAt <= now) this.codes.delete(k);
  }

  /** 第一步:签发 state 并给出 GitHub 授权页 URL。 */
  start(returnTo: string): string {
    this.prune();
    const state = randomBytes(16).toString('hex');
    this.states.set(state, {
      state,
      returnTo,
      expiresAt: this.now() + this.config.oauthStateTtlMs,
    });
    const url = new URL(this.config.githubAuthorizeUrl);
    url.searchParams.set('client_id', this.config.githubClientId);
    url.searchParams.set('redirect_uri', this.config.oauthCallbackUrl);
    // 只要 read:user 拿身份,不要 email(不收集无关个人信息)
    url.searchParams.set('scope', 'read:user');
    url.searchParams.set('state', state);
    url.searchParams.set('allow_signup', 'true');
    return url.toString();
  }

  /**
   * 第二步:GitHub 回跳。校验并消费 state → 用 code 换 access_token → 拉用户 →
   * 建会话 → 生成一次性 aipm_auth_code。
   */
  async callback(rawCode: string | undefined, rawState: string | undefined): Promise<CallbackResult> {
    this.prune();
    if (typeof rawState !== 'string' || rawState.length === 0) {
      return { ok: false, code: 'invalid_state', detail: '缺少 state' };
    }
    const record = this.states.get(rawState);
    // 单次有效:读到即删,复用必然失败
    this.states.delete(rawState);
    if (record === undefined) {
      return { ok: false, code: 'invalid_state', detail: 'state 无效或已过期' };
    }
    if (record.expiresAt <= this.now()) {
      return { ok: false, code: 'invalid_state', detail: 'state 已过期' };
    }
    if (typeof rawCode !== 'string' || rawCode.length === 0) {
      return { ok: false, code: 'invalid_code', detail: '缺少 code' };
    }

    let accessToken: string;
    try {
      accessToken = await this.exchangeCode(rawCode);
    } catch (err) {
      return {
        ok: false,
        code: 'oauth_exchange_failed',
        detail: err instanceof Error ? err.message : '换取 access_token 失败',
      };
    }
    let user: GithubUser;
    try {
      user = await this.fetchUser(accessToken);
    } catch (err) {
      return {
        ok: false,
        code: 'oauth_user_failed',
        detail: err instanceof Error ? err.message : '读取 GitHub 用户失败',
      };
    }

    const token = this.issueSession(user);
    const authCode = randomUUID().replace(/-/g, '');
    this.codes.set(authCode, {
      code: authCode,
      token,
      expiresAt: this.now() + this.config.authCodeTtlMs,
    });
    this.store.setSessions(this.pruneSessions());
    await this.store.flush();
    return { ok: true, returnTo: record.returnTo, authCode };
  }

  private async exchangeCode(code: string): Promise<string> {
    const res = await this.fetchImpl(this.config.githubTokenUrl, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.config.githubClientId,
        client_secret: this.config.githubClientSecret,
        code,
        redirect_uri: this.config.oauthCallbackUrl,
      }),
    });
    if (!res.ok) throw new Error(`token 端点 HTTP ${res.status}`);
    const body = (await res.json()) as { access_token?: unknown; error?: unknown };
    if (typeof body.access_token !== 'string' || body.access_token.length === 0) {
      const err = typeof body.error === 'string' ? body.error : 'no_access_token';
      throw new Error(`token 端点未返回 access_token(${err})`);
    }
    return body.access_token;
  }

  private async fetchUser(accessToken: string): Promise<GithubUser> {
    const res = await this.fetchImpl(`${this.config.githubApiBase}/user`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${accessToken}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'aipm-annotation-server',
      },
    });
    if (!res.ok) throw new Error(`/user HTTP ${res.status}`);
    const body = (await res.json()) as Record<string, unknown>;
    const id = body.id;
    const login = body.login;
    if (typeof id !== 'number' || typeof login !== 'string') {
      throw new Error('/user 返回缺少 id/login');
    }
    const user: GithubUser = { githubId: id, login };
    if (typeof body.name === 'string' && body.name.length > 0) user.name = body.name;
    if (typeof body.avatar_url === 'string') user.avatarUrl = body.avatar_url;
    return user;
  }

  /** 签发会话(只存 hash);返回明文 token。 */
  issueSession(user: GithubUser): string {
    const token = this.randomToken();
    const createdAt = new Date(this.now()).toISOString();
    const session: SessionRecord = {
      tokenHash: hashToken(token),
      githubId: user.githubId,
      login: user.login,
      createdAt,
      expiresAt: new Date(this.now() + this.config.sessionTtlMs).toISOString(),
      revoked: false,
    };
    if (user.name !== undefined) session.name = user.name;
    if (user.avatarUrl !== undefined) session.avatarUrl = user.avatarUrl;
    this.store.setSessions([...this.store.sessions, session]);
    return token;
  }

  /** 移除过期与已吊销会话(懒清理,顺带防文件无限增长)。 */
  private pruneSessions(): SessionRecord[] {
    const nowMs = this.now();
    return this.store.sessions.filter((s) => !s.revoked && Date.parse(s.expiresAt) > nowMs);
  }

  /** 一次性 code 换 token(60 秒、单次)。 */
  redeemAuthCode(code: string): { token: string; user: Author } | null {
    this.prune();
    const record = this.codes.get(code);
    if (record === undefined) return null;
    this.codes.delete(code);
    if (record.expiresAt <= this.now()) return null;
    const session = this.store.sessions.find((s) => s.tokenHash === hashToken(record.token));
    if (session === undefined || session.revoked) return null;
    return { token: record.token, user: authorFromSession(session) };
  }

  /** 校验 bearer token → 作者身份;无效/过期/吊销一律 null(调用方当未登录处理)。 */
  verify(token: string | null): Author | null {
    if (token === null || token.length === 0) return null;
    const hash = hashToken(token);
    const session = this.store.sessions.find((s) => s.tokenHash === hash);
    if (session === undefined || session.revoked) return null;
    if (Date.parse(session.expiresAt) <= this.now()) return null;
    return authorFromSession(session);
  }

  /** 吊销会话并落盘。 */
  async revoke(token: string | null): Promise<boolean> {
    if (token === null || token.length === 0) return false;
    const hash = hashToken(token);
    let hit = false;
    const next = this.store.sessions.map((s) => {
      if (s.tokenHash !== hash || s.revoked) return s;
      hit = true;
      return { ...s, revoked: true };
    });
    if (hit) {
      this.store.setSessions(next.filter((s) => !s.revoked));
      await this.store.flush();
    }
    return hit;
  }

  /**
   * DEV_AUTH_BYPASS:仅在回环地址且显式开启时可用(判定见 config.ts)。
   * 走这条路的会话与真实 OAuth 会话同形,便于本地把登录态整条链路跑通。
   */
  devLogin(): { token: string; user: Author } {
    const user: GithubUser = { githubId: 1, login: this.config.devAuthLogin };
    const token = this.issueSession(user);
    return { token, user: authorFromSession(this.store.sessions[this.store.sessions.length - 1]!) };
  }

  /** 清理空闲资源(测试与优雅退出用)。 */
  reset(): void {
    this.states.clear();
    this.codes.clear();
  }
}
