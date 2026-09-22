/**
 * 站内正文索引(search_index.json):judge 端点用它抽样校验 `blocks` 确实属于
 * 请求声称的那一页 —— 否则这个匿名可用、无需登录的端点就成了一个免费 LLM 代理。
 *
 * 索引结构(2026-08 核实):{config, docs:[{location, title, text}]}。
 * location 形如 "ai/rag/" 整页条目 或 "ai/rag/#锚点" 分节条目。
 *
 * ⚠️ 索引里的 text 是**构建期分词后的形态**:保留了 <p> 等 HTML 标签,且中文
 * 词间被插入了空格(例:"产品 方法论   需求 分析")。所以比对前必须:
 * 去掉标签 → 全角转半角 → 转小写 → **去掉所有空白**。去空白同时抹平了中英
 * 混排("Naive RAG" vs "Naive   RAG")的差异,代价是跨词边界略微变宽松 ——
 * 对「是否属于本页」这个判断来说可以接受。
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

export function stripTags(text: string): string {
  return text.replace(/<[^>]*>/g, '');
}

/** 全角 → 半角(ASCII 区)→ 小写 → 去掉所有空白。见文件头注释。 */
export function normalizeForMatch(text: string): string {
  const bare = stripTags(text);
  let out = '';
  for (let i = 0; i < bare.length; i++) {
    const code = bare.charCodeAt(i);
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCharCode(code - 0xfee0);
    else if (code === 0x3000) out += ' ';
    else out += bare.charAt(i);
  }
  return out.toLowerCase().replace(/\s+/g, '');
}

export type VerifyResult = { ok: true } | { ok: false; id: string; reason: string };

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
  const haystack = normalizeForMatch(pageText);
  if (haystack.length === 0) {
    return { ok: false, id: blocks[0]?.id ?? '', reason: 'index_empty' };
  }
  for (const block of blocks) {
    const needle = normalizeForMatch(block.text);
    if (needle.length === 0) {
      return { ok: false, id: block.id, reason: 'empty_block' };
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
      return { ok: false, id: block.id, reason: 'not_in_page' };
    }
  }
  return { ok: true };
}

/** 页面内容 hash(judge 结果缓存的 key 的一部分)。 */
export function hashPageText(pageText: string): string {
  return createHash('sha256').update(normalizeForMatch(pageText)).digest('hex').slice(0, 32);
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
