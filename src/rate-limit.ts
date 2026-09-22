/**
 * 每 IP 滑动窗口限流 + 并发信号量。
 * IP 先 sha256 哈希再存储,不落原始 IP。
 *
 * 与 aipm-agent-server 的同名模块语义一致,但按本服务需要各写一份(两个服务
 * 独立部署、独立升级,不引跨仓库共享包)。本服务比问答服务多一层「每账号写入
 * 配额」(见 writeQuota),因为批注是写入型接口,按账号计比按 IP 计更准。
 */
import { createHash } from 'node:crypto';

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex');
}

/**
 * 有界并发 map:最多 limit 个任务同时在跑,返回值顺序与输入一致。
 *
 * 与 Semaphore 的分工:信号量管「准入」(会排队、会超时、会被拒绝),这里只负责
 * 把一批**已知互不依赖**的任务分给固定几个工人跑完 —— 分片之间没有依赖,谁先
 * 返回都不影响结果,所以不需要排队与超时语义,只需要一个并发上限。
 * 顺序被保住是为了让上层能按原序合并,使并发与串行的结果逐字节一致。
 *
 * 注意:fn 抛出时 Promise.all 会立即 reject;其余在跑的任务不会被取消(JS 没有
 * 协程取消),它们的结果被丢弃。调用方应保证 fn 自己消化业务错误(本仓库的用法
 * 就是这样:单片失败转成 degraded,不抛)。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  const workers = Math.max(1, Math.min(Math.floor(limit) || 1, items.length));
  let cursor = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: workers }, () => run()));
  return out;
}

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly max: number;
  private readonly windowMs: number;

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  /** 窗口内未超限则记录一次并放行,否则拒绝。 */
  tryAcquire(key: string): boolean {
    const now = Date.now();
    let arr = this.hits.get(key);
    if (arr === undefined) {
      arr = [];
      this.hits.set(key, arr);
    } else {
      while (arr.length > 0 && now - arr[0]! >= this.windowMs) arr.shift();
    }
    if (arr.length >= this.max) return false;
    arr.push(now);
    this.prune();
    return true;
  }

  /** 只读查询:不记账,用于判断「现在是否已被限流」。 */
  isLimited(key: string): boolean {
    const arr = this.hits.get(key);
    if (arr === undefined) return false;
    const now = Date.now();
    while (arr.length > 0 && now - arr[0]! >= this.windowMs) arr.shift();
    return arr.length >= this.max;
  }

  /** 惰性清理:条目数超阈值时清掉已过期 key,防恶意 IP 池打爆内存。 */
  private prune(): void {
    if (this.hits.size < 100_000) return;
    const now = Date.now();
    for (const [key, arr] of this.hits) {
      while (arr.length > 0 && now - arr[0]! >= this.windowMs) arr.shift();
      if (arr.length === 0) this.hits.delete(key);
    }
  }

  /** 下次可放行前还需等待的秒数(仅用于 Retry-After 提示)。 */
  retryAfterSec(): number {
    return Math.max(1, Math.ceil(this.windowMs / 1000));
  }
}

/** 信号量获取失败原因(队列满 / 排队超时 / 请求被中止)。 */
export class SemaphoreError extends Error {
  readonly code: 'queue_full' | 'timeout' | 'aborted';

  constructor(code: 'queue_full' | 'timeout' | 'aborted') {
    super(code === 'queue_full' ? '排队人数过多' : code === 'timeout' ? '排队超时' : '请求已中止');
    this.code = code;
    this.name = 'SemaphoreError';
  }
}

interface Waiter {
  timer: NodeJS.Timeout;
  onSignal: () => void;
  resolve: (release: () => void) => void;
  reject: (err: SemaphoreError) => void;
  cleanup: () => void;
}

/**
 * 信号量 + 有界等待队列:并发满时按 FIFO 排队,超时(QUEUE_WAIT_MS)或
 * 队列满(QUEUE_LIMIT)拒绝;排队中 AbortSignal 中止则取消。
 * 并发上限是成本护栏(每个槽位背后可能是一次真金白银的模型调用)。
 */
export class Semaphore {
  private active = 0;
  private readonly limit: number;
  private readonly waitMs: number;
  private readonly queueLimit: number;
  private readonly waiters: Waiter[] = [];

  constructor(limit: number, opts: { queueLimit?: number; waitMs?: number } = {}) {
    this.limit = limit;
    this.queueLimit = opts.queueLimit ?? 10;
    this.waitMs = opts.waitMs ?? 60_000;
  }

  /** 获取槽位:有空槽立即返回 release;满则排队,失败 reject(SemaphoreError)。 */
  acquire(opts: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<() => void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(this.makeRelease());
    }
    if (this.waiters.length >= this.queueLimit) {
      return Promise.reject(new SemaphoreError('queue_full'));
    }
    const timeoutMs = opts.timeoutMs ?? this.waitMs;
    return new Promise<() => void>((resolve, reject) => {
      if (opts.signal?.aborted) {
        reject(new SemaphoreError('aborted'));
        return;
      }
      let entry: Waiter;
      const cleanup = () => {
        clearTimeout(entry.timer);
        opts.signal?.removeEventListener('abort', entry.onSignal);
        const i = this.waiters.indexOf(entry);
        if (i !== -1) this.waiters.splice(i, 1);
      };
      entry = {
        timer: setTimeout(() => {
          cleanup();
          reject(new SemaphoreError('timeout'));
        }, timeoutMs),
        onSignal: () => {
          cleanup();
          reject(new SemaphoreError('aborted'));
        },
        resolve: (release) => {
          cleanup();
          resolve(release);
        },
        reject,
        cleanup,
      };
      opts.signal?.addEventListener('abort', entry.onSignal, { once: true });
      this.waiters.push(entry);
    });
  }

  /** release 函数:释放槽位;若有排队者,FIFO 直接转移(活跃计数不变)。幂等。 */
  private makeRelease(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) {
        next.resolve(this.makeRelease());
      } else {
        this.active = Math.max(0, this.active - 1);
      }
    };
  }

  get activeCount(): number {
    return this.active;
  }

  get waitingCount(): number {
    return this.waiters.length;
  }
}
