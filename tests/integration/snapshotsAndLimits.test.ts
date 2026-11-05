import request from 'supertest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStack, resolveRedisAvailability, startMongo, waitFor, type Stack } from '../helpers/stack.js';

const redisUp = await resolveRedisAvailability();
const unique = (extra = '') => `q-${Math.random().toString(36).slice(2)} snapshots? ${extra}`;

describe.skipIf(!redisUp)('M5/H2: brand snapshots, ids and Unicode (Redis + Mongo)', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  const post = (body: object, key = 'key-a', qs = '') => request(s.app).post(`/v1/questions${qs}`).set('x-api-key', key).send(body);
  const rows = (tenantId: string, questionId?: string) =>
    s.mongo.db.collection('answer_requests').countDocuments(questionId ? { tenantId, questionId } : { tenantId });

  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri() });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('identical brand sets (order, alias order, Unicode form) stay idempotent and share a brandsHash', async () => {
    const q = unique('same');
    const a = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme', aliases: ['AC', 'Acme Co'] }, { name: 'Café' }] });
    expect(a.status).toBe(200);
    const b = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Café'.normalize('NFD') }, { name: 'Acme', aliases: ['Acme Co', 'AC'] }] });
    expect(b.status).toBe(200);
    expect(b.body.results[0].requestId).toBe(a.body.results[0].requestId);
    expect(b.body.results[0].brandsHash).toBe(a.body.results[0].brandsHash);
    expect(a.body.results[0].brandsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(await s.repos.answers.countByRequest('tenant-a', a.body.results[0].requestId)).toBe(1);
    // GET returns the hash too
    const got = await request(s.app).get(`/v1/questions/${a.body.results[0].requestId}`).set('x-api-key', 'key-a');
    expect(got.body.brandsHash).toBe(a.body.results[0].brandsHash);
  });

  it('a different brand set under the same idempotency key -> 409 brand_snapshot_conflict with both hashes; no new work; questionVersion bump succeeds', async () => {
    const q = unique('conflict');
    const first = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme' }] });
    expect(first.status).toBe(200);
    const stored = first.body.results[0].brandsHash as string;
    const rowsBefore = await rows('tenant-a');
    const callsBefore = s.provider('mock-alpha').callCount((await s.repos.requests.findById('tenant-a', first.body.results[0].requestId))!.idempotencyKey);

    const c = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme' }, { name: 'SneakyNewBrand' }] });
    expect(c.status).toBe(409);
    expect(c.body.error.code).toBe('brand_snapshot_conflict');
    expect(c.body.error.storedBrandsHash).toBe(stored);
    expect(c.body.error.submittedBrandsHash).toMatch(/^[0-9a-f]{64}$/);
    expect(c.body.error.submittedBrandsHash).not.toBe(stored);
    expect(c.body.error.questionVersion).toBe(1);
    expect(JSON.stringify(c.body)).not.toContain('Acme'); // no brand contents beyond hashes
    expect(await rows('tenant-a')).toBe(rowsBefore);
    expect(s.provider('mock-alpha').callCount((await s.repos.requests.findById('tenant-a', first.body.results[0].requestId))!.idempotencyKey)).toBe(callsBefore);

    const bumped = await post({ question: q, providerId: 'mock-alpha', questionVersion: 2, brands: [{ name: 'Acme' }, { name: 'SneakyNewBrand' }] });
    expect(bumped.status).toBe(200);
    expect(bumped.body.results[0].requestId).not.toBe(first.body.results[0].requestId);
    expect(bumped.body.results[0].brandsHash).toBe(c.body.error.submittedBrandsHash);
  });

  it('a conflict on one target creates no work for the other targets of the same call', async () => {
    const q = unique('multi');
    await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme' }] }).expect(200);
    const before = await rows('tenant-a');
    // fan-out to both providers with a different brand set: alpha conflicts, beta must NOT be created
    const c = await post({ question: q, brands: [{ name: 'Globex' }] });
    expect(c.status).toBe(409);
    expect(await rows('tenant-a')).toBe(before);
  });

  it('requests relying on tenant brands compare against the stored snapshot hash (tenant list changed -> 409)', async () => {
    await s.repos.brands.upsert('tenant-b', { brandId: 'initech', name: 'Initech', aliases: [], exclusions: [] });
    const q = unique('tenant-brands');
    const first = await post({ question: q, providerId: 'mock-alpha' }, 'key-b');
    expect(first.status).toBe(200);
    const again = await post({ question: q, providerId: 'mock-alpha' }, 'key-b');
    expect(again.status).toBe(200);
    expect(again.body.results[0].requestId).toBe(first.body.results[0].requestId);

    await s.repos.brands.upsert('tenant-b', { brandId: 'globex', name: 'Globex', aliases: [], exclusions: [] });
    const changed = await post({ question: q, providerId: 'mock-alpha' }, 'key-b');
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('brand_snapshot_conflict');
    expect(changed.body.error.message).toMatch(/tenant's brand list has changed/);
    expect(changed.body.error.storedBrandsHash).toBe(first.body.results[0].brandsHash);

    const bumped = await post({ question: q, providerId: 'mock-alpha', questionVersion: 2 }, 'key-b');
    expect(bumped.status).toBe(200);
  });

  it('concurrent racers with two different brand sets: first insert wins, losers with a different set get 409, one row, one provider call', async () => {
    const q = unique('race');
    const setA = [{ name: 'Acme' }];
    const setB = [{ name: 'Globex' }];
    const rs = await Promise.all(
      Array.from({ length: 10 }, (_, i) => post({ question: q, providerId: 'mock-alpha', brands: i % 2 ? setB : setA })),
    );
    const ok = rs.filter((r) => r.status === 200 || r.status === 202);
    const conflict = rs.filter((r) => r.status === 409);
    expect(ok.length + conflict.length).toBe(10);
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(conflict.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ok.map((r) => r.body.results[0].requestId));
    expect(ids.size).toBe(1);
    const winnerHash = ok[0]!.body.results[0].brandsHash;
    expect(new Set(ok.map((r) => r.body.results[0].brandsHash))).toEqual(new Set([winnerHash]));
    for (const c of conflict) {
      expect(c.body.error.code).toBe('brand_snapshot_conflict');
      expect(c.body.error.storedBrandsHash).toBe(winnerHash);
      expect(c.body.error.submittedBrandsHash).not.toBe(winnerHash);
    }
    const id = [...ids][0]!;
    const row = (await s.repos.requests.findById('tenant-a', id))!;
    expect(await rows('tenant-a', row.questionId)).toBe(1);
    await waitFor(async () => (await s.repos.requests.findById('tenant-a', id))?.status === 'succeeded');
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(1);
    expect(await s.repos.answers.countByRequest('tenant-a', id)).toBe(1);
  });

  it('duplicate brand ids/names are rejected with 400 before any work is created', async () => {
    const before = await rows('tenant-a');
    const names = await post({ question: unique(), providerId: 'mock-alpha', brands: [{ name: 'Acme' }, { name: 'ACME' }] });
    expect(names.status).toBe(400);
    expect(names.body.error.code).toBe('duplicate_brand_id');
    const ids = await post({ question: unique(), providerId: 'mock-alpha', brands: [{ brandId: 'x', name: 'One' }, { brandId: 'x', name: 'Two' }] });
    expect(ids.status).toBe(400);
    expect(ids.body.error.code).toBe('duplicate_brand_id');
    expect(JSON.stringify(names.body)).not.toContain('Acme');
    expect(await rows('tenant-a')).toBe(before);
  });

  it('Unicode brands (Cyrillic, CJK, Arabic, Cafe vs Café) all match as distinct brands end to end', async () => {
    const brands = [{ name: 'Кафе' }, { name: '咖啡' }, { name: 'قهوة' }, { name: 'Café' }, { name: 'Cafe' }, { name: 'Nonexistent Ünïcode' }];
    const res = await post({ question: unique('[[mock:mention=Кафе|咖啡|قهوة|Café|Cafe]]'), providerId: 'mock-alpha', brands });
    expect(res.status).toBe(200);
    const m = res.body.results[0].result.brandMentions as Array<{ brandId: string; name: string; count: number }>;
    expect(m.map((x) => x.name).sort()).toEqual(['Cafe', 'Café', 'Кафе', 'قهوة', '咖啡'].sort());
    expect(new Set(m.map((x) => x.brandId)).size).toBe(5);
    for (const x of m) expect(x.brandId).toMatch(/^b_[0-9a-f]{24}$/);
    const stored = await s.repos.mentions.listByRequest('tenant-a', res.body.results[0].requestId);
    expect(stored).toHaveLength(5);
  });
});

describe.skipIf(!redisUp)('M4: protection and wait control against the real stack', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  const post = (body: object, qs = '') => request(s.app).post(`/v1/questions${qs}`).set('x-api-key', 'key-a').send(body);

  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri(), protection: { maxRequestsPerTenant: 1000 } });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('?wait=0 returns 202 immediately; GET later completes', async () => {
    const t0 = Date.now();
    const res = await post({ question: unique('[[mock:fail=rate_limit;retryAfterMs=500;times=1]]'), providerId: 'mock-alpha' }, '?wait=0');
    expect(Date.now() - t0).toBeLessThan(400);
    expect(res.status).toBe(202);
    expect(res.body.complete).toBe(false);
    const id = res.body.results[0].requestId as string;
    const final = await waitFor(async () => {
      const g = await request(s.app).get(`/v1/questions/${id}`).set('x-api-key', 'key-a');
      return g.body.status === 'succeeded' ? g.body : null;
    });
    expect(final.result.answer.length).toBeGreaterThan(0);
  });

  it('while waiting, only statuses are polled; the full result is fetched once per request on completion', async () => {
    const spy = vi.spyOn(s.repos.answers, 'findByRequest');
    const statusSpy = vi.spyOn(s.repos.requests, 'findStatuses');
    const res = await post({ question: unique('[[mock:fail=rate_limit;retryAfterMs=600;times=1]]'), providerId: 'mock-alpha' });
    expect(res.status).toBe(200);
    expect(statusSpy.mock.calls.length).toBeGreaterThan(5); // it did poll (20 ms interval over ~600 ms)
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    statusSpy.mockRestore();
  });
});
