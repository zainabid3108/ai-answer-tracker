import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/api/app.js';
import { createStaticKeyResolver } from '../../src/api/middleware/auth.js';
import { createLogger } from '../../src/observability/logger.js';
import { ServiceError, type QuestionApi, type SubmitResult } from '../../src/services/questionService.js';

/** API-layer tests with an injected fake service: no Mongo/Redis required. */
function build(overrides: Partial<QuestionApi> = {}, readiness: Array<{ name: string; check: () => Promise<void> }> = []) {
  const done: SubmitResult = { questionId: 'q', complete: true, results: [] };
  const questions: QuestionApi = {
    submit: vi.fn(async () => done),
    get: vi.fn(async () => null),
    ...overrides,
  };
  const app = createApp({
    logger: createLogger('silent'),
    resolveApiKey: createStaticKeyResolver([['key-a', 'tenant-a'], ['key-b', 'tenant-b']]),
    questions,
    readiness,
  });
  return { app, questions };
}

describe('auth', () => {
  it('401 without key and with a wrong key; service never called', async () => {
    const { app, questions } = build();
    const r1 = await request(app).post('/v1/questions').send({ question: 'hi' });
    const r2 = await request(app).post('/v1/questions').set('x-api-key', 'nope').send({ question: 'hi' });
    const r3 = await request(app).get('/v1/questions/00000000-0000-0000-0000-000000000000');
    expect([r1.status, r2.status, r3.status]).toEqual([401, 401, 401]);
    expect(r1.body.error.code).toBe('unauthorized');
    expect(questions.submit).not.toHaveBeenCalled();
  });

  it('passes the resolved tenantId (not client-supplied) to the service', async () => {
    const { app, questions } = build();
    await request(app).post('/v1/questions').set('x-api-key', 'key-b').send({ question: 'hi' }).expect(200);
    expect(questions.submit).toHaveBeenCalledWith('tenant-b', { question: 'hi' }, expect.objectContaining({ wait: true }));
  });

  it('rejects an unknown body field such as tenantId', async () => {
    const { app } = build();
    const r = await request(app).post('/v1/questions').set('x-api-key', 'key-a').send({ question: 'hi', tenantId: 'tenant-b' });
    expect(r.status).toBe(400);
  });
});

describe('validation', () => {
  const post = (app: ReturnType<typeof build>['app'], body: unknown) => request(app).post('/v1/questions').set('x-api-key', 'key-a').send(body as object);

  it.each([
    ['missing question', {}],
    ['empty question', { question: '   ' }],
    ['non-string question', { question: 123 }],
    ['too long question', { question: 'x'.repeat(4001) }],
    ['modelId without providerId', { question: 'q', modelId: 'm' }],
    ['bad providerId chars', { question: 'q', providerId: 'a:b' }],
    ['brand without name', { question: 'q', brands: [{ aliases: ['x'] }] }],
    ['bad questionVersion', { question: 'q', questionVersion: 0 }],
  ])('400 on %s', async (_n, body) => {
    const { app, questions } = build();
    const r = await post(app, body);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('validation_error');
    expect(questions.submit).not.toHaveBeenCalled();
  });

  it('400 on malformed JSON', async () => {
    const { app } = build();
    const r = await request(app).post('/v1/questions').set('x-api-key', 'key-a').set('content-type', 'application/json').send('{bad');
    expect(r.status).toBe(400);
  });

  it('validation errors do not echo submitted values', async () => {
    const { app } = build();
    const r = await post(app, { question: 'q', questionVersion: 'TOP-SECRET-VALUE' });
    expect(JSON.stringify(r.body)).not.toContain('TOP-SECRET-VALUE');
  });

  it('maps ServiceError to its status', async () => {
    const { app } = build({ submit: async () => { throw new ServiceError('unknown_provider_or_model', 400, 'Unknown'); } });
    const r = await post(app, { question: 'q' });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('unknown_provider_or_model');
  });

  it('returns 500 without leaking internals on unexpected errors', async () => {
    const { app } = build({ submit: async () => { throw new Error('mongodb://user:pw@host exploded'); } });
    const r = await post(app, { question: 'q' });
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('pw@host');
  });
});

describe('responses', () => {
  it('202 when the sync wait window elapsed before completion', async () => {
    const pending: SubmitResult = { questionId: 'q', complete: false, results: [{ requestId: 'r', status: 'queued', providerId: 'p', modelId: 'm', runDate: '2026-11-04', brandsHash: 'h' }] };
    const { app } = build({ submit: async () => pending });
    const r = await request(app).post('/v1/questions').set('x-api-key', 'key-a').send({ question: 'q' });
    expect(r.status).toBe(202);
    expect(r.body.results[0].requestId).toBe('r');
  });

  it('GET: 404 for unknown and malformed ids', async () => {
    const { app } = build();
    await request(app).get('/v1/questions/00000000-0000-0000-0000-000000000000').set('x-api-key', 'key-a').expect(404);
    await request(app).get('/v1/questions/not-an-id').set('x-api-key', 'key-a').expect(404);
  });
});

describe('health', () => {
  it('/healthz is open; /readyz reflects dependency checks', async () => {
    const ok = build({}, [{ name: 'mongo', check: async () => {} }]);
    await request(ok.app).get('/healthz').expect(200);
    await request(ok.app).get('/readyz').expect(200);
    const bad = build({}, [{ name: 'redis', check: async () => { throw new Error('down'); } }]);
    const r = await request(bad.app).get('/readyz');
    expect(r.status).toBe(503);
    expect(r.body.checks.redis).toBe('unavailable');
  });
});
