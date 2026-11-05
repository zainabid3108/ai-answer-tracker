import request from 'supertest';
import type { Job } from 'bullmq';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DLQ_NAME } from '../../src/queue/queues.js';
import { createLlmProcessor } from '../../src/workers/llmWorker.js';
import { createLogger } from '../../src/observability/logger.js';
import { createStack, resolveRedisAvailability, startMongo, type Stack } from '../helpers/stack.js';

/**
 * Infra-dependent suite: real Redis (BullMQ) + mongodb-memory-server. Skipped (visibly) when Redis is unreachable.
 */
const redisUp = await resolveRedisAvailability();

describe.skipIf(!redisUp)('pipeline (Redis + Mongo)', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;

  const post = (body: object, key = 'key-a') => request(s.app).post('/v1/questions').set('x-api-key', key).send(body);
  const get = (id: string, key = 'key-a') => request(s.app).get(`/v1/questions/${id}`).set('x-api-key', key);
  const unique = (extra = '') => `q-${Math.random().toString(36).slice(2)} best tools? ${extra}`;

  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri() });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('happy path: question -> ledger -> queue -> worker -> persisted, normalized result', async () => {
    const res = await post({
      question: unique('[[mock:mention=Acme|Globex]]'),
      providerId: 'mock-alpha',
      brands: [{ name: 'Acme', aliases: ['ACME Corp'] }, { name: 'Globex' }, { name: 'Nonexistent Co' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.complete).toBe(true);
    const r = res.body.results[0];
    expect(r).toMatchObject({ status: 'succeeded', providerId: 'mock-alpha', modelId: 'mock-alpha-1' });
    expect(r.runDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expect(r.result.answer).toContain('mock-alpha-1');
    const names = r.result.brandMentions.map((m: { name: string }) => m.name);
    expect(names).toContain('Acme');
    expect(names).toContain('Globex');
    expect(names).not.toContain('Nonexistent Co');
    const acme = r.result.brandMentions.find((m: { name: string }) => m.name === 'Acme');
    expect(acme.count).toBeGreaterThanOrEqual(1);
    expect(acme.firstPosition).toBe(r.result.answer.indexOf('Acme'));
    expect(acme.snippet).toContain('Acme');
    expect(r.result.brandMentions.map((m: { rank: number }) => m.rank)).toEqual(r.result.brandMentions.map((_: unknown, i: number) => i + 1));

    const cite = r.result.citations.find((c: { rawUrl: string }) => c.rawUrl.includes('utm_source'));
    expect(cite).toMatchObject({ normalizedUrl: 'https://www.example.com/reviews/best-tools?a=1&b=2', domain: 'example.com' });
    const urls = r.result.citations.map((c: { normalizedUrl: string }) => c.normalizedUrl);
    expect(new Set(urls).size).toBe(urls.length);
    expect(r.result.usage.outputTokens).toBeGreaterThan(0);
    expect(r.result.latencyMs).toBeGreaterThanOrEqual(0);

    // GET by id returns the same stored result
    const got = await get(r.requestId);
    expect(got.status).toBe(200);
    expect(got.body.result).toEqual(r.result);
  });

  it('uses the tenant\'s predefined brands when none are supplied; fans out to all providers', async () => {
    await s.repos.brands.upsert('tenant-a', { brandId: 'initech', name: 'Initech', aliases: [], exclusions: [] });
    const res = await post({ question: unique('[[mock:mention=Initech]]') });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(2);
    for (const r of res.body.results) {
      expect(r.status).toBe('succeeded');
      expect(r.result.brandMentions.map((m: { brandId: string }) => m.brandId)).toContain('initech');
    }
  });

  it('unknown provider -> 400', async () => {
    const res = await post({ question: unique(), providerId: 'does-not-exist' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('unknown_provider_or_model');
  });

  it('duplicate submission (sequential and concurrent) creates no duplicate ledger row, answer or provider call', async () => {
    const q = unique('dup');
    const first = await post({ question: q, providerId: 'mock-alpha' });
    const [b, c] = await Promise.all([post({ question: q, providerId: 'mock-alpha' }), post({ question: q, providerId: 'mock-alpha' })]);
    const id = first.body.results[0].requestId;
    expect(b.body.results[0].requestId).toBe(id);
    expect(c.body.results[0].requestId).toBe(id);
    expect(b.body.results[0].status).toBe('succeeded');
    expect(await s.repos.answers.countByRequest('tenant-a', id)).toBe(1);
    const row = await s.repos.requests.findById('tenant-a', id);
    expect(s.provider('mock-alpha').callCount(row!.idempotencyKey)).toBe(1);
  });

  it('concurrent duplicate submissions racing before any completion still yield one request', async () => {
    const q = unique('race [[mock:fail=rate_limit;retryAfterMs=150;times=1]]');
    const rs = await Promise.all(Array.from({ length: 5 }, () => post({ question: q, providerId: 'mock-beta' })));
    const ids = new Set(rs.map((r) => r.body.results[0].requestId));
    expect(ids.size).toBe(1);
    expect(await s.repos.answers.countByRequest('tenant-a', [...ids][0]!)).toBe(1);
  });

  it('worker skips an already-succeeded request without calling the provider again', async () => {
    const q = unique('skip');
    const res = await post({ question: q, providerId: 'mock-alpha' });
    const id = res.body.results[0].requestId as string;
    const row = (await s.repos.requests.findById('tenant-a', id))!;
    const processor = createLlmProcessor({
      repos: s.repos, registry: s.registry, deadLetter: s.queues, logger: createLogger('silent'),
      providerTimeoutMs: 300, maxRateLimitHits: 3, staleRunningMs: 10_000, getWorker: () => undefined,
    });
    const fakeJob = { id: row.idempotencyKey, data: { tenantId: 'tenant-a', requestId: id }, opts: { attempts: 3 }, attemptsMade: 0 } as unknown as Job;
    expect(await processor(fakeJob)).toBe('skipped');
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(1);
  });

  it('only one of two concurrent claims wins (atomic queued -> running)', async () => {
    const created = await s.repos.requests.createOrGet('tenant-a', {
      idempotencyKey: `claim-${Math.random()}`, questionId: 'qq', questionVersion: 1, questionText: 'x', brands: [], brandsHash: 'h',
      providerId: 'mock-alpha', modelId: 'mock-alpha-1', runDate: '2026-11-04', sampleIndex: 0,
    });
    const stale = new Date(Date.now() - 60_000);
    const claims = await Promise.all([1, 2, 3, 4].map((n) => s.repos.requests.claim('tenant-a', created.request._id, { jobId: `j${n}`, token: `t${n}`, staleBefore: stale })));
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it('honours 429 Retry-After without burning an attempt', async () => {
    const t0 = Date.now();
    const res = await post({ question: unique('[[mock:fail=rate_limit;retryAfterMs=600;times=1]]'), providerId: 'mock-alpha' });
    const elapsed = Date.now() - t0;
    const r = res.body.results[0];
    expect(r.status).toBe('succeeded');
    expect(elapsed).toBeGreaterThanOrEqual(550);
    const row = (await s.repos.requests.findById('tenant-a', r.requestId))!;
    expect(row.rateLimitHits).toBe(1);
    expect(row.attempts).toBe(0);
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(2);
  });

  it('timeout then success: retried with backoff, attempt consumed', async () => {
    const res = await post({ question: unique('[[mock:fail=timeout;times=1]]'), providerId: 'mock-alpha' });
    const r = res.body.results[0];
    expect(r.status).toBe('succeeded');
    const row = (await s.repos.requests.findById('tenant-a', r.requestId))!;
    expect(row.attempts).toBe(1);
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(2);
  });

  it('5xx exhausting retries -> ledger failed with error class, parked in DLQ', async () => {
    const res = await post({ question: unique('[[mock:fail=server_error]]'), providerId: 'mock-alpha' });
    expect(res.status).toBe(200); // terminal state reached
    const r = res.body.results[0];
    expect(r).toMatchObject({ status: 'failed', errorClass: 'server_error' });
    expect(r.result).toBeUndefined();
    const row = (await s.repos.requests.findById('tenant-a', r.requestId))!;
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(3); // maxAttempts
    expect(row.status).toBe('failed');
    expect(await s.repos.answers.countByRequest('tenant-a', r.requestId)).toBe(0);
    const dead = await s.queues.queue(DLQ_NAME).getJob(row.idempotencyKey);
    expect(dead?.data).toMatchObject({ tenantId: 'tenant-a', requestId: r.requestId, errorClass: 'server_error', providerId: 'mock-alpha' });
  });

  it('non-retryable error (content filter) skips retries and dead-letters', async () => {
    const res = await post({ question: unique('[[mock:fail=content_filter]]'), providerId: 'mock-alpha' });
    const r = res.body.results[0];
    expect(r).toMatchObject({ status: 'failed', errorClass: 'content_filtered' });
    const row = (await s.repos.requests.findById('tenant-a', r.requestId))!;
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(1);
    expect(row.attempts).toBe(0);
    expect(await s.queues.queue(DLQ_NAME).getJob(row.idempotencyKey)).toBeTruthy();
  });

  it('malformed provider output is rejected, nothing persisted, not retried', async () => {
    const res = await post({ question: unique('[[mock:fail=malformed]]'), providerId: 'mock-alpha' });
    const r = res.body.results[0];
    expect(r).toMatchObject({ status: 'failed', errorClass: 'malformed_output' });
    const row = (await s.repos.requests.findById('tenant-a', r.requestId))!;
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(1);
    expect(await s.repos.answers.countByRequest('tenant-a', r.requestId)).toBe(0);
    expect(await s.repos.mentions.listByRequest('tenant-a', r.requestId)).toEqual([]);
  });

  it('tenant isolation: tenant B cannot read tenant A\'s result and gets its own request', async () => {
    const q = unique('iso [[mock:mention=Acme]]');
    const a = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme' }] }, 'key-a');
    const idA = a.body.results[0].requestId;
    expect((await get(idA, 'key-a')).status).toBe(200);

    const peek = await get(idA, 'key-b');
    expect(peek.status).toBe(404);
    expect(JSON.stringify(peek.body)).not.toContain('mock-alpha-1');

    // repository level: every read is tenant scoped
    expect(await s.repos.requests.findById('tenant-b', idA)).toBeNull();
    expect(await s.repos.answers.findByRequest('tenant-b', idA)).toBeNull();
    expect(await s.repos.mentions.listByRequest('tenant-b', idA)).toEqual([]);
    expect(await s.repos.citations.listByRequest('tenant-b', idA)).toEqual([]);
    expect(await s.repos.brands.listByTenant('tenant-b')).toEqual([]);
    await expect(s.repos.requests.findById('', idA)).rejects.toThrow(/tenantId/);

    // same question by tenant B is a different request (idempotency key includes tenantId)
    const b = await post({ question: q, providerId: 'mock-alpha' }, 'key-b');
    expect(b.body.results[0].requestId).not.toBe(idA);
    expect(b.body.results[0].status).toBe('succeeded');
  });

  it('auth failure and validation failure are rejected before any work is created', async () => {
    const before = await s.mongo.db.collection('answer_requests').countDocuments();
    await request(s.app).post('/v1/questions').send({ question: 'x' }).expect(401);
    await post({ question: '' }).expect(400);
    expect(await s.mongo.db.collection('answer_requests').countDocuments()).toBe(before);
  });

  it('readyz reports ok with live Mongo and Redis', async () => {
    const r = await request(s.app).get('/readyz');
    expect(r.status).toBe(200);
    expect(r.body.checks).toEqual({ mongo: 'ok', redis: 'ok' });
  });
});

describe.skipIf(!redisUp)('sync-wait timeout (Redis + Mongo)', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri(), syncWaitMs: 150 });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('returns 202 with the request id when the wait window elapses, and GET completes later', async () => {
    const res = await request(s.app).post('/v1/questions').set('x-api-key', 'key-a')
      .send({ question: `slow ${Math.random()} [[mock:fail=rate_limit;retryAfterMs=900;times=1]]`, providerId: 'mock-alpha' });
    expect(res.status).toBe(202);
    expect(res.body.complete).toBe(false);
    const id = res.body.results[0].requestId as string;
    expect(['queued', 'running']).toContain(res.body.results[0].status);

    let final = res.body.results[0];
    for (let i = 0; i < 100 && final.status !== 'succeeded'; i++) {
      await new Promise((r) => setTimeout(r, 100));
      final = (await request(s.app).get(`/v1/questions/${id}`).set('x-api-key', 'key-a')).body;
    }
    expect(final.status).toBe('succeeded');
    expect(final.result.answer.length).toBeGreaterThan(0);
  });
});

if (!redisUp) {
  // Surfaces in the report as a skipped suite; this makes the reason explicit.
  console.warn('Redis not reachable: pipeline integration suites were SKIPPED');
}
