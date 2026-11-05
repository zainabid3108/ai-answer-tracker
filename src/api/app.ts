import express, { type ErrorRequestHandler, type Express } from 'express';
import { ZodError } from 'zod';
import type { Logger } from '../observability/logger.js';
import { ServiceError, type QuestionApi } from '../services/questionService.js';
import { authMiddleware, type ApiKeyResolver } from './middleware/auth.js';
import { FixedWindowLimiter, InflightGate, tenantRateLimit } from './middleware/rateLimit.js';
import { healthRouter, type ReadinessCheck } from './routes/health.js';
import { questionsRouter, type InputLimits } from './routes/questions.js';

export interface AppDeps {
  logger: Logger;
  resolveApiKey: ApiKeyResolver;
  questions: QuestionApi;
  readiness: ReadinessCheck[];
  /** In-process protections (single instance; see docs/decisions.md). Defaults are generous. */
  protection?: {
    rateLimitWindowMs?: number;
    maxRequestsPerTenant?: number;
    /** Failed-auth attempts per IP per window. */
    maxUnauthPerIp?: number;
    maxInflightWaitsPerTenant?: number;
    maxInflightWaitsGlobal?: number;
    bodyLimitBytes?: number;
    clock?: () => number;
  };
  limits?: InputLimits;
}

export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(healthRouter(deps.readiness));

  // Access log: method, route, status, duration, tenant. Never bodies, query strings or headers.
  app.use((req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      deps.logger.info(
        { method: req.method, path: req.path.replace(/[0-9a-f-]{36}/g, ':id'), status: res.statusCode, ms: Math.round(performance.now() - start), tenantId: res.locals.tenantId },
        'http_request',
      );
    });
    next();
  });

  const p = deps.protection ?? {};
  const windowMs = p.rateLimitWindowMs ?? 60_000;
  const failedAuthLimiter = new FixedWindowLimiter(p.maxUnauthPerIp ?? 30, windowMs, p.clock);
  const tenantLimiter = new FixedWindowLimiter(p.maxRequestsPerTenant ?? 300, windowMs, p.clock);
  const inflight = new InflightGate(p.maxInflightWaitsPerTenant ?? 10, p.maxInflightWaitsGlobal ?? 100);

  app.use(authMiddleware(deps.resolveApiKey, failedAuthLimiter)); // auth before body parsing: unauthenticated callers never reach the parser
  app.use(tenantRateLimit(tenantLimiter)); // before body parsing: throttled tenants cost no JSON parsing
  app.use(express.json({ limit: p.bodyLimitBytes ?? 102_400 }));
  app.use(questionsRouter(deps.questions, { inflight, ...(deps.limits ? { limits: deps.limits } : {}) }));

  app.use((_req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: 'Route not found' } });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof ZodError) {
      res.status(400).json({
        error: {
          code: 'validation_error',
          message: 'Invalid request',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
      return;
    }
    if (err instanceof ServiceError) {
      res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, ...(err.details ?? {}) } });
      return;
    }
    const status = (err as { status?: number }).status;
    if (status === 413) {
      res.status(413).json({ error: { code: 'payload_too_large', message: 'Request body is too large' } });
      return;
    }
    if (status && status >= 400 && status < 500) {
      res.status(status).json({ error: { code: 'bad_request', message: 'Malformed request' } });
      return;
    }
    deps.logger.error({ err: err instanceof Error ? err.message : 'unknown' }, 'unhandled_error');
    res.status(500).json({ error: { code: 'internal_error', message: 'Internal server error' } });
  };
  app.use(onError);
  return app;
}
