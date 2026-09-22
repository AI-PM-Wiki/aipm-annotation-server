/**
 * 站内正文索引(search_index.json):judge 端点用它抽样校验 `blocks` 确实属于
 * 请求声称的那一页 —— 否则这个匿名可用、无需登录的端点就成了一个免费 LLM 代理。
 *
 * 索引结构(2026-08 核实):{config, docs:[{location, title, text}]}。
 * location 形如 "ai/rag/" 整页条目 或 "ai/rag/#锚点" 分节条目。
 *
 * ⚠️ 索引里的 text 是**构建期重写过的形态**(见 hooks/on_env.py 的 on_post_build):
 * 正文先 jieba 分词、词间插空格(例:"产品 方法论   需求 分析"),再按句子包进
 * <p> 块,最后整体 html.escape。所以索引里只有 `<p>` / `</p>` 这一种标签,其余
 * `<`、`>`、`&`、引号、撇号全是实体("NPV &lt; 0"、"Cohen&#x27;s")。
 *
 * 于是比对前的归一化必须是:HTML 实体解码 → 摘掉 <p>/</p> 包装 → 全角转半角 →
 * 转小写 → **去掉所有空白**。不对齐这三件事,前端 DOM 的 textContent 与索引就
 * 比不了(2026-09-22 issue #87:含 < > & 引号 撇号的段落全被误判为「不属于该页」,
 * 实测覆盖全站 229 页)。去空白同时抹平了中英混排("Naive RAG" vs
 * "Naive   RAG")的差异,代价是跨词边界略微变宽松 —— 对「是否属于本页」这个判断
 * 来说可以接受。
 */
import { createHash } from 'node:crypto';

export interface IndexStats {
  pageCount: number;
  docCount: number;
  stale: boolean;
  lastLoadedAt: number | null;
  lastError: string | null;
}

export interface PageBlock {
  id: string;
  text: string;
}

/**
 * 服务端只需要索引的这四件事(judge 校验 + /healthz + 后台刷新)。
 * 抽成接口是为了让单测能塞一个不触网的假索引。
 */
export interface IndexLike {
  hasPage(page: string): boolean;
  pageText(page: string): string;
  getStats(): IndexStats;
  startAutoRefresh(): void;
  stop(): void;
}

/** 把 search_index.json 的 location 归一成站点路径:"ai/rag/#x" → "/ai/rag/"。 */
export function normalizePagePath(location: string): string {
  const noHash = location.split('#', 1)[0]!;
  const noQuery = noHash.split('?', 1)[0]!;
  const trimmed = noQuery.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : `/${trimmed}/`;
}

/**
 * 把前端传来的 page 归一成站点路径;不是本站路径时返回 null。
 * 只接受路径形态(location.pathname),带协议/主机的一律拒绝 —— 防 SSRF 与
 * 「拿别站 URL 当页面」。
 */
export function canonicalPage(page: string): string | null {
  if (typeof page !== 'string') return null;
  const raw = page.trim();
  if (raw.length === 0 || raw.length > 512) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null; // 协议相对 URL
  if (raw.includes('\\') || raw.includes('\0')) return null;
  const noHash = raw.split('#', 1)[0]!;
  const noQuery = noHash.split('?', 1)[0]!;
  if (noQuery.includes('..')) return null;
  const trimmed = noQuery.replace(/^\/+/, '').replace(/\/+$/, '');
  return trimmed.length === 0 ? '/' : `/${trimmed}/`;
}

function entityCodePoint(digits: string, radix: number, raw: string): string {
  const code = Number.parseInt(digits, radix);
  // 畸形实体(越界码点)原样保留,别让一个坏字节把整次校验炸掉
  if (!Number.isInteger(code) || code < 0 || code > 0x10ffff) return raw;
  return String.fromCodePoint(code);
}

/**
 * HTML 实体解码。索引侧被 html.escape 过,前端 DOM 的 textContent 是解码后的
 * 字符,不解码两边就永远差一层转义。
 *
 * `&amp;` 必须最后解:先解会把 `&amp;lt;` 变成 `&lt;`,再被下一轮解成 `<`。
 */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-fA-F]+);/g, (raw, hex: string) => entityCodePoint(hex, 16, raw))
    .replace(/&#([0-9]+);/g, (raw, dec: string) => entityCodePoint(dec, 10, raw))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 摘掉索引自身的块包装(`<p>` / `</p>`,on_post_build 按句子切的)。
 *
 * 只认这一对,不做通用的 `<[^>]*>` 去标签:正文里裸的 `<`(「首 token < 1 秒」)
 * 会被通用正则当成标签头,在整页 haystack 上一路吃到几百字外的下一个 `>`,而块
 * 文本(前端 DOM 的 textContent)里那个 `<` 未必有配对的 `>` —— 两侧被削成不同的
 * 样子,于是同样一句话验不过。通用去标签在索引保留原始正文标签的时代是对的,
 * 现在索引里除了 <p> 包装没有别的标签,它只剩副作用。
 */
export function stripIndexTags(text: string): string {
  return text.replace(/<\/?p>/gi, '');
}

/** 折平:全角 → 半角(ASCII 区)→ 小写 → 去掉所有空白。见文件头注释。 */
function fold(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) out += ' ';
    else out += text.charAt(i);
  }
  return out.toLowerCase().replace(/\s+/g, '');
}

/** 索引侧文本归一化:实体解码 → 摘掉 <p>/</p> 包装 → 折平。 */
export function normalizeIndexText(text: string): string {
  return fold(stripIndexTags(decodeEntities(text)));
}

/**
 * 块文本归一化。块文本是前端 DOM 的 textContent —— 浏览器已经把实体解开了,
 * 所以这里**不再解码**:再解一次会把页面上字面写着 `&lt;` 的文本错解成 `<`,
 * 与索引侧对不上。摘 <p>/</p> 与折平则与索引侧同一套变换,保持两边可比。
 */
export function normalizeForMatch(text: string): string {
  return fold(stripIndexTags(text));
}

export interface BlockRejection {
  id: string;
  /** 'not_in_page' | 'empty_block' | 'index_empty'。 */
  reason: string;
}

/**
 * 逐块结论。**不是**整批 ok/失败:验不过的块由调用方丢弃并降级,而不是把整个请求
 * 打死 —— 前端按 DOM 抽块,抽到的未必都是该页正文(主题模板文字、MathJax 渲染后的
 * 公式都可能与索引对不上),一个页脚段落不该让整页「智能高亮」不可用(issue #87)。
 * 防滥用的口子没有变宽:调用方只在「一块都验不过」时才 400,所以能进模型的仍然
 * 只有索引里找得到的文本。
 */
export interface VerifyResult {
  accepted: PageBlock[];
  rejected: BlockRejection[];
}

/** 抽样窗口数:块越长取得越多,但最多 4 个(够用且不可被拖成重计算)。 */
export const VERIFY_WINDOWS = 4;
/** 采样窗口保底占比:至少这么多窗口命中才算「确属该页」。 */
export const VERIFY_MIN_RATIO = 0.6;

/**
 * 抽样校验一批块是否属于该页:在归一化后的块文本上均匀取至多 VERIFY_WINDOWS 个
 * 窗口,逐个在归一化后的页面正文里找,命中比例 ≥ VERIFY_MIN_RATIO 才算通过。
 * 短块(不足一个窗口)按整块比对。
 *
 * 纯函数:不触网、不读文件,便于单测。
 */
export function verifyBlocks(
  pageText: string,
  blocks: PageBlock[],
  sampleChars: number,
): VerifyResult {
  const haystack = normalizeIndexText(pageText);
  const accepted: PageBlock[] = [];
  const rejected: BlockRejection[] = [];
  for (const block of blocks) {
    if (haystack.length === 0) {
      rejected.push({ id: block.id, reason: 'index_empty' });
      continue;
    }
    const needle = normalizeForMatch(block.text);
    if (needle.length === 0) {
      rejected.push({ id: block.id, reason: 'empty_block' });
      continue;
    }
    const windows: string[] = [];
    if (needle.length <= sampleChars) {
      windows.push(needle);
    } else {
      const step = Math.floor((needle.length - sampleChars) / (VERIFY_WINDOWS - 1));
      for (let i = 0; i < VERIFY_WINDOWS; i++) {
        windows.push(needle.slice(i * step, i * step + sampleChars));
      }
    }
    let hit = 0;
    for (const w of windows) {
      if (w.length > 0 && haystack.includes(w)) hit++;
    }
    if (hit / windows.length < VERIFY_MIN_RATIO) {
      rejected.push({ id: block.id, reason: 'not_in_page' });
      continue;
    }
    accepted.push(block);
  }
  return { accepted, rejected };
}

/** 页面内容 hash(judge 结果缓存的 key 的一部分)。 */
export function hashPageText(pageText: string): string {
  return createHash('sha256').update(normalizeIndexText(pageText)).digest('hex').slice(0, 32);
}

interface RawDoc {
  location?: unknown;
  title?: unknown;
  text?: unknown;
}

/**
 * 按页聚合的正文索引。与 aipm-agent-server 的 WikiIndex 同源同形,但只做
 * 「按页取全文」这一件事(问答那边要 BM25 检索,这边不需要)。
 */
export class PageTextIndex implements IndexLike {
  private readonly indexUrl: string;
  private readonly refreshMs: number;
  private pages = new Map<string, string>();
  private docCount = 0;
  private lastLoadedAt: number | null = null;
  private lastError: string | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(indexUrl: string, refreshMs: number) {
    this.indexUrl = indexUrl;
    this.refreshMs = refreshMs;
  }

  /** 首次加载;失败抛出 → 启动失败(与问答服务一致)。 */
  async load(): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    let json: unknown;
    try {
      const res = await fetch(this.indexUrl, { signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      json = await res.json();
    } finally {
      clearTimeout(timer);
    }
    const docs = (json as { docs?: unknown }).docs;
    if (!Array.isArray(docs)) throw new Error('search_index.json 结构不符:缺少 docs 数组');

    const next = new Map<string, string>();
    for (const rawDoc of docs as RawDoc[]) {
      const location = typeof rawDoc.location === 'string' ? rawDoc.location : '';
      const text = typeof rawDoc.text === 'string' ? rawDoc.text : '';
      const title = typeof rawDoc.title === 'string' ? rawDoc.title : '';
      if (text.length === 0) continue;
      const page = normalizePagePath(location);
      // 整页条目与分节条目都并入同一页:重复内容只会让抽样比对更宽松,不会漏判。
      next.set(page, (next.get(page) ?? '') + title + ' ' + text);
    }
    this.pages = next;
    this.docCount = docs.length;
    this.lastLoadedAt = Date.now();
    this.lastError = null;
  }

  /** 后台刷新;失败保留旧索引并记录 lastError(stale 标记)。 */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      await this.load();
    } catch (err) {
      // URL 只进服务日志,不上 lastError(公开 /healthz 可读)。
      this.lastError = err instanceof Error ? err.message.slice(0, 200) : 'unknown';
      console.log(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'index_refresh_failed',
          url: this.indexUrl,
          error: this.lastError,
        }),
      );
    } finally {
      this.refreshing = false;
    }
  }

  startAutoRefresh(): void {
    if (this.refreshTimer !== null || this.refreshMs <= 0) return;
    this.refreshTimer = setInterval(() => {
      void this.refresh();
    }, this.refreshMs);
  }

  stop(): void {
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  getStats(): IndexStats {
    return {
      pageCount: this.pages.size,
      docCount: this.docCount,
      stale: this.lastError !== null,
      lastLoadedAt: this.lastLoadedAt,
      lastError: this.lastError,
    };
  }

  hasPage(page: string): boolean {
    return this.pages.has(page);
  }

  pageText(page: string): string {
    return this.pages.get(page) ?? '';
  }
}
