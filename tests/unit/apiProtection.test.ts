import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp, type AppDeps } from '../../src/api/app.js';
import { createStaticKeyResolver } from '../../src/api/middleware/auth.js';
import { DEFAULT_BRAND_LIMITS } from '../../src/domain/brands.js';
import { createLogger } from '../../src/observability/logger.js';
import { ServiceError, type QuestionApi, type SubmitResult } from '../../src/services/questionService.js';

const done: SubmitResult = { questionId: 'q', complete: true, results: [] };

function build(over: Partial<QuestionApi> = {}, deps: Partial<AppDeps> = {}) {
  const questions: QuestionApi = { submit: vi.fn(async () => done), get: vi.fn(async () => null), ...over };
  const app = createApp({
    logger: createLogger('silent'),
    resolveApiKey: createStaticKeyResolver([['key-a', 'tenant-a'], ['key-b', 'tenant-b']]),
    questions,
    readiness: [],
    ...deps,
  });
  return { app, questions };
}
const post = (app: ReturnType<typeof build>['app'], body: object, key = 'key-a', qs = '') =>
  request(app).post(`/v1/questions${qs}`).set('x-api-key', key).send(body);

describe('rate limiting (M4)', () => {
  it('429 with Retry-After and a stable code once the tenant budget is spent; other tenants unaffected; window resets', async () => {
    let now = 1_000_000;
    const { app, questions } = build({}, { protection: { maxRequestsPerTenant: 3, rateLimitWindowMs: 60_000, clock: () => now } });
    for (let i = 0; i < 3; i++) await post(app, { question: 'q' }).expect(200);
    const r = await post(app, { question: 'q' });
    expect(r.status).toBe(429);
    expect(r.body.error.code).toBe('rate_limited');
    expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    expect(questions.submit).toHaveBeenCalledTimes(3); // throttled request never reached the service
    await post(app, { question: 'q' }, 'key-b').expect(200);
    await request(app).get('/v1/questions/00000000-0000-0000-0000-000000000000').set('x-api-key', 'key-a').expect(429); // GET shares the budget
    now += 60_001;
    await post(app, { question: 'q' }).expect(200);
  });

  it('per-IP fallback throttles repeated failed authentication without affecting valid keys', async () => {
    const { app } = build({}, { protection: { maxUnauthPerIp: 2 } });
    await post(app, { question: 'q' }, 'bad-1').expect(401);
    await post(app, { question: 'q' }, 'bad-2').expect(401);
    const r = await post(app, { question: 'q' }, 'bad-3');
    expect(r.status).toBe(429);
    expect(r.headers['retry-after']).toBeDefined();
    expect(r.body.error.code).toBe('rate_limited');
    await post(app, { question: 'q' }, 'key-a').expect(200); // valid tenants are not penalised
  });

  it('health endpoints are not rate limited', async () => {
    const { app } = build({}, { protection: { maxRequestsPerTenant: 1, maxUnauthPerIp: 1 } });
    for (let i = 0; i < 5; i++) await request(app).get('/healthz').expect(200);
  });
});

describe('in-flight sync-wait cap (M4)', () => {
  function gated() {
    const waiters: Array<() => void> = [];
    const submit = vi.fn(async (_t: string, _i: unknown, opts?: { wait?: boolean }) => {
      if (opts?.wait) await new Promise<void>((r) => waiters.push(r));
      return { ...done, complete: opts?.wait === true };
    });
    return { submit, waiters, release: () => waiters.splice(0).forEach((r) => r()) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('per tenant: excess requests are accepted but answered 202 immediately with waitSkipped; slots are released', async () => {
    const g = gated();
    const { app } = build({ submit: g.submit }, { protection: { maxInflightWaitsPerTenant: 2, maxInflightWaitsGlobal: 100 } });
    const first = [post(app, { question: 'q' }).then((r) => r), post(app, { question: 'q' }).then((r) => r)];
    await settle();
    const third = await post(app, { question: 'q' });
    expect(third.status).toBe(202);
    expect(third.body.waitSkipped).toBe('inflight_limit');
    expect(third.headers['x-wait-skipped']).toBe('inflight_limit');
    expect(g.submit.mock.calls.at(-1)![2]).toMatchObject({ wait: false });
    // another tenant still gets its own slots
    const other = post(app, { question: 'q' }, 'key-b').then((r) => r);
    await settle();
    g.release();
    expect((await other).status).toBe(200);
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
    // slots free again
    const again = post(app, { question: 'q' }).then((r) => r);
    await settle();
    g.release();
    expect((await again).status).toBe(200);
  });

  it('globally: a different tenant is also degraded once the global cap is reached', async () => {
    const g = gated();
    const { app } = build({ submit: g.submit }, { protection: { maxInflightWaitsPerTenant: 5, maxInflightWaitsGlobal: 2 } });
    const held = [post(app, { question: 'q' }, 'key-a').then((r) => r), post(app, { question: 'q' }, 'key-a').then((r) => r)];
    await settle();
    const r = await post(app, { question: 'q' }, 'key-b');
    expect(r.status).toBe(202);
    expect(r.body.waitSkipped).toBe('inflight_limit');
    g.release();
    await Promise.all(held);
  });

  it('releases the slot when the service throws', async () => {
    const { app } = build({ submit: async () => { throw new ServiceError('queue_unavailable', 503, 'x'); } }, { protection: { maxInflightWaitsPerTenant: 1 } });
    for (let i = 0; i < 3; i++) expect((await post(app, { question: 'q' })).status).toBe(503);
  });
});

describe('wait control (M4)', () => {
  it.each([['?wait=0', false], ['?wait=false', false], ['?wait=1', true], ['', true]])('%s -> wait=%s', async (qs, expected) => {
    const { app, questions } = build();
    await post(app, { question: 'q' }, 'key-a', qs).expect(200);
    expect((questions.submit as ReturnType<typeof vi.fn>).mock.calls[0]![2]).toMatchObject({ wait: expected });
  });

  it('rejects unknown wait values with 400', async () => {
    const { app, questions } = build();
    const r = await post(app, { question: 'q' }, 'key-a', '?wait=banana');
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).not.toContain('banana');
    expect(questions.submit).not.toHaveBeenCalled();
  });
});

describe('input limits (M4/M6)', () => {
  const limits = { maxQuestionChars: 50, brand: { ...DEFAULT_BRAND_LIMITS, maxBrands: 2, maxAliasesPerBrand: 2 } };
  const body413 = 1000;

  it.each([
    ['question over the configured max', { question: 'x'.repeat(51) }],
    ['too many brands', { question: 'q', brands: [{ name: 'A1' }, { name: 'B1' }, { name: 'C1' }] }],
    ['too many aliases on a brand', { question: 'q', brands: [{ name: 'A1', aliases: ['aa', 'bb', 'cc'] }] }],
    ['1-char alias', { question: 'q', brands: [{ name: 'A1', aliases: ['a'] }] }],
    ['1-char object alias', { question: 'q', brands: [{ name: 'A1', aliases: [{ value: 'a' }] }] }],
    ['over-long alias', { question: 'q', brands: [{ name: 'A1', aliases: ['a'.repeat(101)] }] }],
  ])('400 validation_error: %s', async (_n, body) => {
    const { app, questions } = build({}, { limits });
    const r = await post(app, body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(questions.submit).not.toHaveBeenCalled();
  });

  it('413 payload_too_large (distinct from malformed JSON 400)', async () => {
    const { app, questions } = build({}, { protection: { bodyLimitBytes: body413 } });
    const r = await post(app, { question: 'q', pad: 'x'.repeat(body413 * 2) });
    expect(r.status).toBe(413);
    expect(r.body.error.code).toBe('payload_too_large');
    const bad = await request(app).post('/v1/questions').set('x-api-key', 'key-a').set('content-type', 'application/json').send('{bad');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('bad_request');
    expect(questions.submit).not.toHaveBeenCalled();
  });

  it('oversize bodies are rejected only after authentication', async () => {
    const { app } = build({}, { protection: { bodyLimitBytes: body413 } });
    const r = await request(app).post('/v1/questions').send({ question: 'x'.repeat(5000) });
    expect(r.status).toBe(401);
  });
});

describe('409 brand_snapshot_conflict mapping (M5)', () => {
  it('returns hashes and a stable code, nothing else from the stored snapshot', async () => {
    const { app } = build({
      submit: async () => {
        throw new ServiceError('brand_snapshot_conflict', 409, 'conflict', { storedBrandsHash: 'aaa', submittedBrandsHash: 'bbb', questionVersion: 1 });
      },
    });
    const r = await post(app, { question: 'q' });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatchObject({ code: 'brand_snapshot_conflict', storedBrandsHash: 'aaa', submittedBrandsHash: 'bbb', questionVersion: 1 });
  });
});
