import { z } from 'zod';

const num = (def: number) => z.coerce.number().int().positive().default(def);
/** Strict boolean env flag: only "true" / "false" are accepted (anything else is a startup error). */
const flag = () => z.enum(['true', 'false']).default('false').transform((v) => v === 'true');

const schema = z
  .object({
    /** REQUIRED, no default: a missing NODE_ENV must never silently become a non-production mode. */
    NODE_ENV: z.enum(['development', 'test', 'production'], {
      error: 'must be set explicitly to one of: development, test, production (case-sensitive)',
    }),
    PORT: num(3000),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    MONGO_URL: z.string().min(1).default('mongodb://127.0.0.1:27017'),
    MONGO_DB: z.string().min(1).default('ai_answer_tracker'),
    REDIS_URL: z.string().min(1).default('redis://127.0.0.1:6379'),
    QUEUE_PREFIX: z.string().regex(/^[A-Za-z0-9_-]+$/).default('aat'),
    /** STUB AUTH - "apiKey:tenantId,apiKey2:tenantId2". Placeholder; revisit before production. */
    API_KEYS: z.string().default(''),

    /** mock = deterministic mock adapters; real = vendor adapters (none exist yet -> startup fails fast). */
    PROVIDER_MODE: z.enum(['mock', 'real']).default('mock'),
    /** Explicit, loud override required to run mock providers with NODE_ENV=production. */
    ALLOW_MOCK_IN_PRODUCTION: flag(),
    /** Enables [[mock:...]] prompt directives. Dev/test only; refused in production. */
    ENABLE_MOCK_FAILURE_INJECTION: flag(),

    API_SYNC_WAIT_MS: num(8000),
    PROVIDER_TIMEOUT_MS: num(20000),
    LOCK_DURATION_MS: num(35000),
    MAX_ATTEMPTS: num(4),
    BACKOFF_BASE_MS: num(1000),
    BACKOFF_MAX_MS: num(60000),
    MAX_RATE_LIMIT_HITS: num(10),
    WORKER_CONCURRENCY: num(5),

    // API protection (in-process, single instance - see docs/decisions.md)
    RATE_LIMIT_WINDOW_MS: num(60_000),
    RATE_LIMIT_MAX_PER_TENANT: num(300),
    RATE_LIMIT_MAX_UNAUTH_PER_IP: num(30),
    MAX_INFLIGHT_WAITS_PER_TENANT: num(10),
    MAX_INFLIGHT_WAITS_GLOBAL: num(100),

    // Input / workload limits
    BODY_LIMIT_BYTES: num(102_400),
    MAX_QUESTION_CHARS: num(4000),
    MAX_TARGETS_PER_REQUEST: num(20),
    MAX_BRANDS: num(100),
    MAX_ALIASES_PER_BRAND: num(50),
    MAX_TOTAL_ALIASES: num(500),
  })
  .refine((e) => e.LOCK_DURATION_MS > e.PROVIDER_TIMEOUT_MS, {
    message: 'LOCK_DURATION_MS must be greater than PROVIDER_TIMEOUT_MS',
    path: ['LOCK_DURATION_MS'],
  });

export type Env = z.infer<typeof schema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Report only variable names and messages - never values (they may be secrets).
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${msg}`);
  }
  return parsed.data;
}

/** tenantId charset: safe for Mongo filters, log fields and the '|'-joined idempotency key. */
export const TENANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Parse the stub API_KEYS list into [apiKey, tenantId] pairs.
 * Throws one Error listing every problem by entry NUMBER only - key and tenant values are never echoed.
 */
export function parseApiKeys(raw: string, opts: { minKeyLength?: number } = {}): Array<[string, string]> {
  const minLen = opts.minKeyLength ?? 1;
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const issues: string[] = [];
  const out: Array<[string, string]> = [];
  const firstSeen = new Map<string, number>();
  entries.forEach((pair, i) => {
    const n = i + 1;
    const idx = pair.indexOf(':');
    if (idx <= 0 || idx === pair.length - 1) {
      issues.push(`entry ${n} must be apiKey:tenantId`);
      return;
    }
    const key = pair.slice(0, idx);
    const tenantId = pair.slice(idx + 1);
    if (!TENANT_ID_RE.test(tenantId)) issues.push(`entry ${n} has an invalid tenantId (allowed: letters, digits, underscore, hyphen; 1-64 chars; must start alphanumeric)`);
    if (key.length < minLen) issues.push(`entry ${n} has an API key shorter than ${minLen} characters`);
    const dup = firstSeen.get(key);
    if (dup !== undefined) issues.push(`entry ${n} duplicates the API key of entry ${dup}`);
    else firstSeen.set(key, n);
    out.push([key, tenantId]);
  });
  if (issues.length) throw new Error(`Invalid API_KEYS: ${issues.join('; ')}`);
  return out;
}
