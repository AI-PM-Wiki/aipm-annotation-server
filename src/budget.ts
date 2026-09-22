/**
 * 每日护栏(UTC 日切,进程内状态)。
 *
 * 两种护栏各管一件事:
 *  - DailyBudget:按金额(USD)累计的预占-结算模型。judge 调用的费用在调用前
 *    按「本片理论最大成本」预占,拿到 usage 后按实际结算、失败路径释放,
 *    这样并发请求也不可能同时穿过预算线(Node 单线程下 tryReserve 的
 *    检查+记账是同一个同步步骤)。
 *  - DailyCounter:按「调用次数」计的硬上限。金额护栏防不住「很多次极便宜的
 *    调用」和「计价未知的 provider」,次数上限是兜底。
 *
 * 进程内状态,单实例假设:重启清零(README 已注明;多实例需换共享存储,记 deferred)。
 * 金额为 0 / 次数为 0 表示关闭对应护栏。
 */

export class DailyBudget {
  private readonly budgetUsd: number;
  private readonly now: () => Date;
  private day: string;
  private spent = 0;
  /** 已预占未结算量(进行中请求的理论最大成本之和)。 */
  private reserved = 0;

  constructor(budgetUsd: number, now: () => Date = () => new Date()) {
    this.budgetUsd = budgetUsd;
    this.now = now;
    this.day = this.dayKey();
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  /** 跨日自动重置(已消耗与预占一并清零)。 */
  private resetIfNewDay(): void {
    const key = this.dayKey();
    if (key !== this.day) {
      this.day = key;
      this.spent = 0;
      this.reserved = 0;
    }
  }

  /**
   * 只读取值也先跨日重置:否则跨过 UTC 零点后,/healthz 里的水位会一直显示
   * 昨天的数字,直到有请求恰好走一次写路径才刷新(问答服务那份只读 getter
   * 不复位,靠请求路径必然先调 tryReserve 自愈 —— 这里顺手修掉这个隐患)。
   */
  get spentUsd(): number {
    this.resetIfNewDay();
    return this.spent;
  }

  get reservedUsd(): number {
    this.resetIfNewDay();
    return this.reserved;
  }

  /** 剩余可预分配预算(USD);护栏关闭时为 Infinity。 */
  get remainingUsd(): number {
    if (this.budgetUsd <= 0) return Number.POSITIVE_INFINITY;
    this.resetIfNewDay();
    return Math.max(0, this.budgetUsd - this.spent - this.reserved);
  }

  /** 是否已超预算(含预占;供日志/统计使用,请求准入请用 tryReserve)。 */
  get exhausted(): boolean {
    if (this.budgetUsd <= 0) return false;
    this.resetIfNewDay();
    return this.spent + this.reserved >= this.budgetUsd;
  }

  /** 原子预占:同步完成「检查+记账」,余量不足返回 false。预算关闭时恒 true。 */
  tryReserve(estimateUsd: number): boolean {
    if (this.budgetUsd <= 0) return true;
    this.resetIfNewDay();
    if (this.spent + this.reserved + estimateUsd > this.budgetUsd) return false;
    this.reserved += estimateUsd;
    return true;
  }

  /**
   * 结算:预占转实际消耗(costUsd 可为 0,未产生费用同样要 settle 以释放预占)。
   * 跨日时已重置的预占按 0 截断,避免负预占放大余量。
   */
  settle(estimateUsd: number, costUsd: number): void {
    this.resetIfNewDay();
    this.reserved = Math.max(0, this.reserved - estimateUsd);
    this.spent += costUsd;
  }

  /** 异常路径释放预占(请求未执行即失败时调用)。 */
  release(estimateUsd: number): void {
    this.resetIfNewDay();
    this.reserved = Math.max(0, this.reserved - estimateUsd);
  }

  /** 直接记账一次消耗(不涉及预占;保留给测试/统计场景)。 */
  track(costUsd: number): void {
    this.resetIfNewDay();
    this.spent += costUsd;
  }
}

/** 按日计数的调用上限。limit <= 0 表示关闭。 */
export class DailyCounter {
  private readonly limit: number;
  private readonly now: () => Date;
  private day: string;
  private used = 0;

  constructor(limit: number, now: () => Date = () => new Date()) {
    this.limit = limit;
    this.now = now;
    this.day = this.dayKey();
  }

  private dayKey(): string {
    return this.now().toISOString().slice(0, 10);
  }

  private resetIfNewDay(): void {
    const key = this.dayKey();
    if (key !== this.day) {
      this.day = key;
      this.used = 0;
    }
  }

  get usedCount(): number {
    return this.used;
  }

  /** 未超上限则记一次并放行。 */
  tryAcquire(): boolean {
    if (this.limit <= 0) return true;
    this.resetIfNewDay();
    if (this.used >= this.limit) return false;
    this.used++;
    return true;
  }
}
