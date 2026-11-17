/** Simple token bucket keyed by an arbitrary string (IP, user id...). */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updated: number }>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** True if `cost` tokens are available, without consuming them. */
  canTake(key: string, cost = 1): boolean {
    const b = this.buckets.get(key);
    if (!b) return true;
    const elapsed = (this.now() - b.updated) / 1000;
    return Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond) >= cost;
  }

  take(key: string, cost = 1): boolean {
    const t = this.now();
    let b = this.buckets.get(key);
    if (!b) {
      b = { tokens: this.capacity, updated: t };
      this.buckets.set(key, b);
    }
    const elapsed = (t - b.updated) / 1000;
    b.tokens = Math.min(this.capacity, b.tokens + elapsed * this.refillPerSecond);
    b.updated = t;
    if (b.tokens < cost) return false;
    b.tokens -= cost;
    if (this.buckets.size > 5000) this.prune();
    return true;
  }

  private prune(): void {
    const t = this.now();
    for (const [k, b] of this.buckets) {
      if (t - b.updated > 10 * 60 * 1000) this.buckets.delete(k);
    }
  }
}
