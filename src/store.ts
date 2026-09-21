/**
 * 批注存储:纯文件(不引 SQLite)。
 *
 * 形态:单个 JSON 文件 + 原子写(先写 .tmp 再 rename)+ 进程内索引 + 启动加载。
 * 会话与用户身份快照也存在同一文件里(重启不丢登录态;token 本身仍有 TTL)。
 * OAuth state 与一次性 aipm_auth_code 是**进程内**的短命状态,不入文件 ——
 * 它们本就只在一次 OAuth 往返的几十秒内有效,重启丢掉只会让那一次登录重来。
 *
 * 写策略:所有写入经同一条 promise 队列串行化(避免两次 rename 交错),
 * 并用 dirty 标记把同一 tick 内的多次修改合并成一次落盘。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type Visibility = 'public' | 'private';

/**
 * 批注的**画法**,与 color(颜色)正交:
 *   underline 只画下划线;highlight 只铺底色;both 两者都画。
 * 缺省 highlight —— 这也是引入这个字段之前的行为,老记录读出来仍是老样子。
 */
export type AnnotationStyle = 'underline' | 'highlight' | 'both';

export type Selector =
  | { type: 'TextQuoteSelector'; exact: string; prefix?: string; suffix?: string }
  | { type: 'TextPositionSelector'; start: number; end: number }
  | {
      type: 'RangeSelector';
      xpath?: string;
      startXpath?: string;
      endXpath?: string;
      startOffset?: number;
      endOffset?: number;
    };

export interface Author {
  /** GitHub 数字 id —— 归属判定的键,不拿 login 当键(login 可改)。 */
  githubId: number;
  /** 写入时的快照,仅用于展示。 */
  login: string;
  name?: string;
  avatarUrl?: string;
}

export interface Reply {
  id: string;
  body: string;
  author: Author;
  createdAt: string;
  updatedAt: string;
  /**
   * 回复的回复:指向同一条批注下另一条回复的 id。
   * 父回复被删之后这里会留下一个悬空 id —— 前端把「找不到父级」的当成顶层回复渲染,
   * 不在服务端做级联删除:删一条回复不该顺手抹掉别人在它下面的发言。
   */
  parentId?: string;
}

export interface AnnotationRecord {
  id: string;
  /** 站点路径,如 "/ai/rag/"。 */
  page: string;
  visibility: Visibility;
  color: string;
  style: AnnotationStyle;
  body: string;
  author: Author;
  /**
   * 锚点。`scope: 'page'` = 全页评论:不锚定正文任何一段文字,selectors 为空数组。
   * 这是与「批注」并列的第二维(锚定粒度),与 visibility(可见范围)正交 ——
   * 一条全页评论同样可以是公开/私有。缺省即普通批注(必须至少一条 selector)。
   */
  target: { selectors: Selector[]; scope?: 'page' };
  replies: Reply[];
  /** 点过赞的人的 GitHub 数字 id,升序无重复。对外只暴露计数与「我赞过没」,
   *  见 annotations.ts 的 toClientJson —— 谁赞过是隐私面,也没有展示价值。 */
  likes: number[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionRecord {
  /** 只存 token 的 sha256;明文 token 仅在签发那一刻回给客户端。 */
  tokenHash: string;
  githubId: number;
  login: string;
  name?: string;
  avatarUrl?: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
}

/** 落盘结构。带 version 便于日后迁移。 */
export interface StoredState {
  version: 1;
  annotations: AnnotationRecord[];
  sessions: SessionRecord[];
}

const EMPTY_STATE: StoredState = { version: 1, annotations: [], sessions: [] };

/** 单条批注的点赞数上限。存储文件可能被手工编辑,解析时不设上限就是给自己挖坑。 */
const MAX_LIKES = 50_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 宽松读取:文件损坏或字段缺失时按「能救多少救多少」解析,而不是整体拒绝启动
 * ——批注是用户内容,宁可有损也不该因为一条坏记录让整个服务起不来。
 * 坏记录被丢弃并计数,由调用方打日志。
 */
export function parseState(raw: string): { state: StoredState; dropped: number } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error('存储文件不是合法 JSON');
  }
  if (!isRecord(json)) throw new Error('存储文件顶层不是对象');
  const annotations: AnnotationRecord[] = [];
  const sessions: SessionRecord[] = [];
  let dropped = 0;

  const rawAnnotations = Array.isArray(json.annotations) ? json.annotations : [];
  for (const item of rawAnnotations) {
    const a = parseAnnotation(item);
    if (a === null) dropped++;
    else annotations.push(a);
  }
  const rawSessions = Array.isArray(json.sessions) ? json.sessions : [];
  for (const item of rawSessions) {
    const s = parseSession(item);
    if (s === null) dropped++;
    else sessions.push(s);
  }
  return { state: { version: 1, annotations, sessions }, dropped };
}

function parseAuthor(value: unknown): Author | null {
  if (!isRecord(value)) return null;
  const githubId = value.githubId;
  if (typeof githubId !== 'number' || !Number.isFinite(githubId)) return null;
  const author: Author = {
    githubId,
    login: typeof value.login === 'string' ? value.login : '',
  };
  if (typeof value.name === 'string') author.name = value.name;
  if (typeof value.avatarUrl === 'string') author.avatarUrl = value.avatarUrl;
  return author;
}

function parseAnnotation(value: unknown): AnnotationRecord | null {
  if (!isRecord(value)) return null;
  const { id, page, visibility, color, body, createdAt, updatedAt } = value;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof page !== 'string' || page.length === 0) return null;
  if (visibility !== 'public' && visibility !== 'private') return null;
  if (typeof body !== 'string') return null;
  const author = parseAuthor(value.author);
  if (author === null) return null;
  const target = isRecord(value.target) ? value.target : {};
  const selectors = Array.isArray(target.selectors)
    ? (target.selectors as Selector[]).filter(isRecord) as Selector[]
    : [];
  // 全页评论的标记要透传:解析时吞掉它,这条评论下次重启就会退化成「锚点为空
  // 的普通批注」,前端随即把它判成孤儿。
  const scope: 'page' | undefined = target.scope === 'page' ? 'page' : undefined;
  const replies: Reply[] = [];
  if (Array.isArray(value.replies)) {
    for (const item of value.replies) {
      if (!isRecord(item)) continue;
      const replyAuthor = parseAuthor(item.author);
      if (replyAuthor === null || typeof item.id !== 'string' || typeof item.body !== 'string') continue;
      const reply: Reply = {
        id: item.id,
        body: item.body,
        author: replyAuthor,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : new Date(0).toISOString(),
        updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : new Date(0).toISOString(),
      };
      if (typeof item.parentId === 'string' && item.parentId.length > 0) {
        reply.parentId = item.parentId;
      }
      replies.push(reply);
    }
  }
  // 认不出的 style 一律回落 highlight(而不是丢整条记录):这是画法,不是内容
  const style: AnnotationStyle =
    value.style === 'underline' || value.style === 'both' ? value.style : 'highlight';
  const likes: number[] = [];
  if (Array.isArray(value.likes)) {
    for (const item of value.likes) {
      if (typeof item !== 'number' || !Number.isFinite(item)) continue;
      if (likes.includes(item)) continue;
      likes.push(item);
      if (likes.length >= MAX_LIKES) break;
    }
  }
  const now = new Date(0).toISOString();
  return {
    id,
    page,
    visibility,
    color: typeof color === 'string' && color.length > 0 ? color : 'yellow',
    style,
    body,
    author,
    target: scope === undefined ? { selectors } : { selectors, scope },
    replies,
    likes,
    createdAt: typeof createdAt === 'string' ? createdAt : now,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : now,
  };
}

function parseSession(value: unknown): SessionRecord | null {
  if (!isRecord(value)) return null;
  const { tokenHash, githubId, expiresAt } = value;
  if (typeof tokenHash !== 'string' || tokenHash.length === 0) return null;
  if (typeof githubId !== 'number' || !Number.isFinite(githubId)) return null;
  if (typeof expiresAt !== 'string') return null;
  const session: SessionRecord = {
    tokenHash,
    githubId,
    login: typeof value.login === 'string' ? value.login : '',
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : new Date(0).toISOString(),
    expiresAt,
    revoked: value.revoked === true,
  };
  if (typeof value.name === 'string') session.name = value.name;
  if (typeof value.avatarUrl === 'string') session.avatarUrl = value.avatarUrl;
  return session;
}

export class AnnotationStore {
  private readonly filePath: string;
  private readonly tmpPath: string;
  private state: StoredState = EMPTY_STATE;
  private writeChain: Promise<void> = Promise.resolve();
  private dirty = false;
  private flushing = false;
  private lastWriteError: string | null = null;

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'store.json');
    this.tmpPath = `${this.filePath}.tmp`;
  }

  get path(): string {
    return this.filePath;
  }

  get lastError(): string | null {
    return this.lastWriteError;
  }

  /** 启动加载:文件不存在按空库起步(首次部署无需预置文件)。 */
  async load(): Promise<{ dropped: number; annotations: number; sessions: number }> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        this.state = { version: 1, annotations: [], sessions: [] };
        return { dropped: 0, annotations: 0, sessions: 0 };
      }
      throw err;
    }
    const { state, dropped } = parseState(raw);
    this.state = state;
    return { dropped, annotations: state.annotations.length, sessions: state.sessions.length };
  }

  /** 只读视图(调用方不得改写返回的对象)。 */
  get snapshot(): StoredState {
    return this.state;
  }

  get annotations(): AnnotationRecord[] {
    return this.state.annotations;
  }

  get sessions(): SessionRecord[] {
    return this.state.sessions;
  }

  setAnnotations(annotations: AnnotationRecord[]): void {
    this.state = { ...this.state, annotations };
    this.markDirty();
  }

  setSessions(sessions: SessionRecord[]): void {
    this.state = { ...this.state, sessions };
    this.markDirty();
  }

  private markDirty(): void {
    this.dirty = true;
  }

  /** 等待当前所有排队写入落盘(单测与优雅退出用)。 */
  async flush(): Promise<void> {
    if (!this.dirty) {
      await this.writeChain;
      return;
    }
    if (this.flushing) {
      await this.writeChain;
      return;
    }
    this.flushing = true;
    this.dirty = false;
    const payload = JSON.stringify(this.state);
    this.writeChain = this.writeChain.then(async () => {
      try {
        await writeFile(this.tmpPath, payload, 'utf8');
        await rename(this.tmpPath, this.filePath); // 原子替换:读到的一半新一半旧不可能发生
        this.lastWriteError = null;
      } catch (err) {
        this.lastWriteError = err instanceof Error ? err.message : 'unknown';
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'store_write_failed',
            error: this.lastWriteError,
          }),
        );
      } finally {
        this.flushing = false;
        // 落盘期间又有新修改:再冲一次
        if (this.dirty) void this.flush();
      }
    });
    await this.writeChain;
  }
}
