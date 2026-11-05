import { createHash, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { sendRateLimited, type FixedWindowLimiter } from './rateLimit.js';

/**
 * STUB AUTH (placeholder - revisit before production): static API keys from env map to a tenantId.
 * Keys are compared by sha256 digest with timingSafeEqual and are never logged.
 */
export type ApiKeyResolver = (apiKey: string) => string | null;

const sha = (s: string) => createHash('sha256').update(s).digest();

export function createStaticKeyResolver(pairs: Array<[string, string]>): ApiKeyResolver {
  const table = pairs.map(([key, tenantId]) => ({ digest: sha(key), tenantId }));
  return (apiKey) => {
    const d = sha(apiKey);
    let found: string | null = null;
    for (const row of table) if (timingSafeEqual(row.digest, d)) found = row.tenantId; // no early exit
    return found;
  };
}

/**
 * @param failedAuthLimiter optional per-IP fallback limiter: only FAILED authentications consume it, which
 *   throttles API-key guessing without penalising legitimate tenants behind a shared IP.
 */
export function authMiddleware(resolve: ApiKeyResolver, failedAuthLimiter?: FixedWindowLimiter) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.header('x-api-key');
    const tenantId = key ? resolve(key) : null;
    if (!tenantId) {
      if (failedAuthLimiter) {
        const r = failedAuthLimiter.consume(`ip:${req.ip ?? 'unknown'}`);
        if (!r.allowed) return sendRateLimited(res, r.retryAfterSec);
      }
      res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or invalid API key' } });
      return;
    }
    res.locals.tenantId = tenantId;
    next();
  };
}
