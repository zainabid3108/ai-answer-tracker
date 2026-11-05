import type { NextFunction, Request, Response } from 'express';

/**
 * In-process fixed-window rate limiter.
 *
 * LIMITATION (revisit before production): state lives in this process's memory, so with N API instances the
 * effective limit is N x max and a restart resets all counters. A multi-instance deployment needs a shared
 * store (e.g. Redis INCR+EXPIRE or a token bucket script). Behind a reverse proxy configure Express
 * "trust proxy" so req.ip is the client address, not the proxy's.
 */
export class FixedWindowLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly clock: () => number = Date.now,
    /** Memory bound: oldest keys are evicted beyond this many distinct keys. */
    private readonly maxKeys = 10_000,
  ) {}

  consume(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.clock();
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      if (this.hits.size >= this.maxKeys) this.prune(now);
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    return { allowed: e.count <= this.max, retryAfterSec: Math.max(1, Math.ceil((e.resetAt - now) / 1000)) };
  }

  private prune(now: number): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    for (const k of this.hits.keys()) {
      if (this.hits.size < this.maxKeys) break;
      this.hits.delete(k); // still full of live keys: drop oldest
    }
  }
}

export function sendRateLimited(res: Response, retryAfterSec: number): void {
  res.setHeader('Retry-After', String(retryAfterSec));
  res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests', retryAfterSec } });
}

/** Per-tenant limit; must run after authentication. */
export function tenantRateLimit(limiter: FixedWindowLimiter) {
  return (_req: Request, res: Response, next: NextFunction): void => {
    const r = limiter.consume(`tenant:${res.locals.tenantId as string}`);
    if (!r.allowed) return sendRateLimited(res, r.retryAfterSec);
    next();
  };
}

/** Caps concurrent in-flight sync waits per tenant and globally. */
export class InflightGate {
  private readonly perTenant = new Map<string, number>();
  private total = 0;

  constructor(
    private readonly maxPerTenant: number,
    private readonly maxGlobal: number,
  ) {}

  /** Returns a release function, or null when a cap is reached. Release is idempotent. */
  tryAcquire(tenantId: string): (() => void) | null {
    const mine = this.perTenant.get(tenantId) ?? 0;
    if (mine >= this.maxPerTenant || this.total >= this.maxGlobal) return null;
    this.perTenant.set(tenantId, mine + 1);
    this.total++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const n = (this.perTenant.get(tenantId) ?? 1) - 1;
      if (n <= 0) this.perTenant.delete(tenantId);
      else this.perTenant.set(tenantId, n);
    };
  }

  snapshot(): { total: number; tenants: number } {
    return { total: this.total, tenants: this.perTenant.size };
  }
}
