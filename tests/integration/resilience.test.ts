import request from 'supertest';
import { Worker } from 'bullmq';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Repositories } from '../../src/db/repositories/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { DLQ_NAME, llmQueueName, type DeadLetterPayload, type DeadLetterSink, type QueueManager } from '../../src/queue/queues.js';
import { jobIdFor } from '../../src/services/questionService.js';
import { ensureDeadLettered, recoverPendingDeadLetters } from '../../src/workers/llmWorker.js';
import { createStack, resolveRedisAvailability, startMongo, waitFor, type Stack } from '../helpers/stack.js';

const redisUp = await resolveRedisAvailability();
const unique = (extra = '') => `q-${Math.random().toString(36).slice(2)} resilience? ${extra}`;
const TENANT = 'tenant-a';

/** Fails the first N calls of the named repos.requests methods with a Mongo-like error. */
function flaky(repos: Repositories, plan: Record<string, number>): Repositories {
  const requests = new Proxy(repos.requests, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        if ((plan[prop] ?? 0) > 0) {
          plan[prop]!--;
          return Promise.reject(new Error(`injected mongo failure in ${prop}`));
        }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { ...repos, requests };
}

async function dlqEntries(s: Stack, requestId: string) {
  const jobs = await s.queues.queue(DLQ_NAME).getJobs(['waiting', 'delayed', 'active', 'completed', 'failed', 'prioritized']);
  return jobs.filter((j) => j.data.requestId === requestId);
}

describe.skipIf(!redisUp)('H1: stalled / redelivered jobs and lost ledger writes', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  const post = (body: object, qs = '') => request(s.app).post(`/v1/questions${qs}`).set('x-api-key', 'key-a').send(body);
  const terminal = (id: string) => waitFor(async () => {
    const r = await s.repos.requests.findById(TENANT, id);
    return r && (r.status === 'succeeded' || r.status === 'failed') ? r : null;
  }, 25_000);

  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri(), startWorkers: false, lockDurationMs: 1500, stalledIntervalMs: 400, staleRunningMs: 1500 });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('worker dies mid-job (lock lost): the redelivered job reclaims its own running row and finishes - no hang, no duplicates', async () => {
    const q = unique('stall');
    const res = await post({ question: q, providerId: 'mock-alpha', brands: [{ name: 'Acme' }] }, '?wait=0');
    expect(res.status).toBe(202);
    const id = res.body.results[0].requestId as string;
    const key = (await s.repos.requests.findById(TENANT, id))!.idempotencyKey;

    // A "worker" that claims the row exactly like the real one and then dies without finishing.
    const dying = new Worker(
      llmQueueName('mock-alpha'),
      async (job, token) => {
        await s.repos.requests.claim(TENANT, id, { jobId: String(job.id), token: token!, staleBefore: new Date(Date.now() - 60_000) });
        await new Promise(() => undefined); // never returns; lock is not renewed after close(true)
      },
      { connection: s.connection, prefix: s.prefix, lockDuration: 1500, stalledInterval: 400 }, // short interval: BullMQ's stalled-check key is shared per queue
    );
    await waitFor(async () => (await s.repos.requests.findById(TENANT, id))?.status === 'running');
    await dying.close(true);

    await s.startWorkers(); // a healthy worker appears; BullMQ's stalled checker redelivers the job
    const row = await terminal(id);
    expect(row.status).toBe('succeeded');
    expect(await s.repos.answers.countByRequest(TENANT, id)).toBe(1);
    expect(s.provider('mock-alpha').callCount(key)).toBe(1); // the dead worker never reached the provider
    expect(row.ownerToken).toBeUndefined();
    const job = await s.queues.queue(llmQueueName('mock-alpha')).getJob(key);
    expect(await job!.getState()).toBe('completed');
  }, 40_000);

  it('a fresh running row owned by ANOTHER job is delayed (not skipped); once stale it is taken over and finishes', async () => {
    // Workers are running, so build the state BEFORE the job exists: row claimed by a ghost job, then enqueue.
    const { request: created } = await s.repos.requests.createOrGet(TENANT, {
      idempotencyKey: `conflict-${Math.random().toString(36).slice(2)}`, questionId: 'qc', questionVersion: 1, questionText: 'conflict question',
      brands: [], brandsHash: 'h', providerId: 'mock-beta', modelId: 'mock-beta-1', runDate: '2026-11-04', sampleIndex: 0,
    });
    const id = created._id;
    const key = created.idempotencyKey;
    expect(await s.repos.requests.claim(TENANT, id, { jobId: 'ghost-job', token: 'ghost-token', staleBefore: new Date(Date.now() - 60_000) })).toBeTruthy();
    await s.queues.enqueue({ providerId: 'mock-beta', jobId: key, tenantId: TENANT, requestId: id });
    const row = await terminal(id);
    expect(row.status).toBe('succeeded');
    expect(s.provider('mock-beta').callCount(key)).toBe(1);
    expect(await s.repos.answers.countByRequest(TENANT, id)).toBe(1);
  }, 40_000);

  it('zombie writes are fenced: a stale owner token cannot finish or fail a row another delivery owns', async () => {
    const created = await s.repos.requests.createOrGet(TENANT, {
      idempotencyKey: `fence-${Math.random()}`, questionId: 'qf', questionVersion: 1, questionText: 'x', brands: [], brandsHash: 'h',
      providerId: 'mock-alpha', modelId: 'mock-alpha-1', runDate: '2026-11-04', sampleIndex: 0,
    });
    const id = created.request._id;
    const old = new Date(Date.now() - 60_000);
    expect(await s.repos.requests.claim(TENANT, id, { jobId: 'j1', token: 'old-token', staleBefore: old })).toBeTruthy();
    // same job id is redelivered -> reclaims, fencing out 'old-token'
    expect(await s.repos.requests.claim(TENANT, id, { jobId: 'j1', token: 'new-token', staleBefore: old })).toBeTruthy();
    // a different job cannot take a fresh running row
    expect(await s.repos.requests.claim(TENANT, id, { jobId: 'j2', token: 't2', staleBefore: old })).toBeNull();
    expect(await s.repos.requests.markSucceeded(TENANT, id, 'ans', 'old-token')).toBe(false);
    expect(await s.repos.requests.markFailed(TENANT, id, 'server_error', 'old-token')).toBe(false);
    expect(await s.repos.requests.requeue(TENANT, id, 'server_error', true, 'old-token')).toBe(false);
    expect((await s.repos.requests.findById(TENANT, id))!.status).toBe('running');
    expect(await s.repos.requests.markSucceeded(TENANT, id, 'ans', 'new-token')).toBe(true);
  });

  it('submit() re-enqueues an orphaned running row under a new job id even though the old job lingers; racing submitters reclaim exactly once', async () => {
    const q = unique('orphan');
    const first = await post({ question: q, providerId: 'mock-alpha' }, '?wait=0');
    const id = first.body.results[0].requestId as string;
    const key = (await s.repos.requests.findById(TENANT, id))!.idempotencyKey;
    // The original job lingers in Redis (here completed; a failed/stalled-out job behaves the same: re-adding its id is a no-op)
    // and the ledger row is stuck 'running' with an old startedAt.
    const alphaQ = s.queues.queue(llmQueueName('mock-alpha'));
    await waitFor(async () => (await alphaQ.getJob(key)) && (await (await alphaQ.getJob(key))!.getState()) === 'completed');
    await s.mongo.db.collection('answer_requests').updateOne(
      { _id: id as never },
      { $set: { status: 'running', startedAt: new Date(Date.now() - 60_000), ownerJobId: 'dead', ownerToken: 'dead' }, $unset: { answerId: '', finishedAt: '' } },
    );
    await s.mongo.db.collection('answers').deleteMany({ requestId: id });

    const rs = await Promise.all(Array.from({ length: 5 }, () => post({ question: q, providerId: 'mock-alpha' })));
    expect(new Set(rs.map((r) => r.body.results[0].requestId))).toEqual(new Set([id]));
    const row = await terminal(id);
    expect(row.status).toBe('succeeded');
    expect(row.enqueueEpoch).toBe(1); // exactly one reclaim among the 5 racers
    expect(await alphaQ.getJob(jobIdFor(key, 1))).toBeTruthy();
    expect(await s.repos.answers.countByRequest(TENANT, id)).toBe(1);
  }, 40_000);
});

describe.skipIf(!redisUp)('Mongo failures inside the handler', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  const plan: Record<string, number> = {};
  const post = (body: object) => request(s.app).post('/v1/questions').set('x-api-key', 'key-a').send(body);
  const terminal = (id: string) => waitFor(async () => {
    const r = await s.repos.requests.findById(TENANT, id);
    return r && (r.status === 'succeeded' || r.status === 'failed') ? r : null;
  }, 25_000);
  const reset = () => { for (const k of Object.keys(plan)) delete plan[k]; };

  beforeAll(async () => {
    mongod = await startMongo();
    s = await createStack({ mongoUri: mongod.getUri(), lockDurationMs: 1500, staleRunningMs: 1500, wrapWorkerRepos: (r) => flaky(r, plan) });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('requeue() throws during a retryable failure: row stays running, redelivery of the same job reclaims it and succeeds', async () => {
    reset();
    plan.requeue = 1;
    const res = await post({ question: unique('[[mock:fail=server_error;times=1]]'), providerId: 'mock-alpha' });
    const r = res.body.results[0];
    const row = await terminal(r.requestId);
    expect(plan.requeue).toBe(0);
    expect(row.status).toBe('succeeded');
    expect(await s.repos.answers.countByRequest(TENANT, r.requestId)).toBe(1);
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(2);
  }, 40_000);

  it('markSucceeded() throws after the answer was saved: retried without duplicate answer/mentions', async () => {
    reset();
    plan.markSucceeded = 1;
    const res = await post({ question: unique('[[mock:mention=Acme]]'), providerId: 'mock-alpha', brands: [{ name: 'Acme' }] });
    const id = res.body.results[0].requestId as string;
    const row = await terminal(id);
    expect(plan.markSucceeded).toBe(0);
    expect(row.status).toBe('succeeded');
    expect(await s.repos.answers.countByRequest(TENANT, id)).toBe(1);
    expect((await s.repos.mentions.listByRequest(TENANT, id)).filter((m) => m.brandId.length > 0)).toHaveLength(1);
  }, 40_000);

  it('claim() throws: the job is retried and the request still completes', async () => {
    reset();
    plan.claim = 1;
    const res = await post({ question: unique(), providerId: 'mock-alpha' });
    const row = await terminal(res.body.results[0].requestId);
    expect(row.status).toBe('succeeded');
    expect(plan.claim).toBe(0);
  }, 40_000);

  it('markFailed() throws on a non-retryable failure: job is retried, request ends failed with exactly one DLQ entry', async () => {
    reset();
    plan.markFailed = 1;
    const res = await post({ question: unique('[[mock:fail=content_filter]]'), providerId: 'mock-alpha' });
    const id = res.body.results[0].requestId as string;
    const row = await terminal(id);
    expect(plan.markFailed).toBe(0);
    expect(row.status).toBe('failed');
    expect(row.errorClass).toBe('content_filtered');
    await waitFor(async () => (await dlqEntries(s, id)).length > 0);
    expect(await dlqEntries(s, id)).toHaveLength(1);
    await waitFor(async () => (await s.repos.requests.findById(TENANT, id))?.deadLettered === true);
  }, 40_000);

  it('markFailed() keeps failing until the job exhausts its attempts: row is stranded running, then submit() recovers it terminally with a DLQ entry', async () => {
    reset();
    plan.markFailed = 3; // every delivery of the first job fails to write the final status
    const q = unique('[[mock:fail=content_filter]]');
    const res = await post({ question: q, providerId: 'mock-beta' });
    const id = res.body.results[0].requestId as string;
    const key = (await s.repos.requests.findById(TENANT, id))!.idempotencyKey;
    const betaQ = s.queues.queue(llmQueueName('mock-beta'));
    await waitFor(async () => (await betaQ.getJob(key)) && (await (await betaQ.getJob(key))!.getState()) === 'failed', 25_000);
    expect(plan.markFailed).toBe(0);
    expect((await s.repos.requests.findById(TENANT, id))!.status).toBe('running'); // stranded - the old behaviour forever

    await new Promise((r) => setTimeout(r, 1700)); // let it become stale
    const again = await post({ question: q, providerId: 'mock-beta' });
    expect(again.body.results[0].requestId).toBe(id);
    expect(again.body.results[0].status).toBe('failed');
    const row = (await s.repos.requests.findById(TENANT, id))!;
    expect(row.enqueueEpoch).toBe(1);
    await waitFor(async () => (await dlqEntries(s, id)).length > 0);
    expect(await dlqEntries(s, id)).toHaveLength(1);
  }, 60_000);
});

describe.skipIf(!redisUp)('M1: dead-letter write failures are recoverable and never duplicated', () => {
  let mongod: MongoMemoryServer;
  let s: Stack;
  const dl = { failures: 0, always: false, attempts: 0 };
  const post = (body: object) => request(s.app).post('/v1/questions').set('x-api-key', 'key-a').send(body);

  beforeAll(async () => {
    mongod = await startMongo();
    const wrap = (q: QueueManager): DeadLetterSink => ({
      async deadLetter(jobId: string, payload: DeadLetterPayload) {
        dl.attempts++;
        if (dl.always || dl.failures > 0) {
          if (dl.failures > 0) dl.failures--;
          throw new Error('injected DLQ outage');
        }
        await q.deadLetter(jobId, payload);
      },
    });
    s = await createStack({ mongoUri: mongod.getUri(), wrapDeadLetter: wrap });
  });
  afterAll(async () => {
    await s?.stop();
    await mongod?.stop();
  });

  it('markFailed succeeded but the DLQ add threw once: the job retry writes the entry (once)', async () => {
    Object.assign(dl, { failures: 1, always: false, attempts: 0 });
    const res = await post({ question: unique('[[mock:fail=content_filter]]'), providerId: 'mock-alpha' });
    const id = res.body.results[0].requestId as string;
    expect(res.body.results[0].status).toBe('failed'); // ledger is the source of truth and is already terminal
    await waitFor(async () => (await dlqEntries(s, id)).length > 0, 20_000);
    await waitFor(async () => (await s.repos.requests.findById(TENANT, id))?.deadLettered === true, 20_000);
    expect(await dlqEntries(s, id)).toHaveLength(1);
    expect(dl.attempts).toBeGreaterThanOrEqual(2);
    const row = (await s.repos.requests.findById(TENANT, id))!;
    expect(s.provider('mock-alpha').callCount(row.idempotencyKey)).toBe(1); // recovery never re-ran the provider
  }, 40_000);

  it('DLQ stays down past the job\'s retries: nothing lost - the recovery sweep writes it later, once, and is idempotent', async () => {
    Object.assign(dl, { failures: 0, always: true, attempts: 0 });
    const res = await post({ question: unique('[[mock:fail=content_filter]]'), providerId: 'mock-beta' });
    const id = res.body.results[0].requestId as string;
    const key = (await s.repos.requests.findById(TENANT, id))!.idempotencyKey;
    const betaQ = s.queues.queue(llmQueueName('mock-beta'));
    await waitFor(async () => (await betaQ.getJob(key)) && (await (await betaQ.getJob(key))!.getState()) === 'failed', 25_000);
    let row = (await s.repos.requests.findById(TENANT, id))!;
    expect(row.status).toBe('failed');
    expect(row.deadLettered).toBe(false);
    expect(await dlqEntries(s, id)).toHaveLength(0);

    dl.always = false; // DLQ back
    const deps = { repos: s.repos, deadLetter: s.queues, logger: createLogger('silent') };
    expect(await recoverPendingDeadLetters(deps)).toBe(1);
    expect(await dlqEntries(s, id)).toHaveLength(1);
    row = (await s.repos.requests.findById(TENANT, id))!;
    expect(row.deadLettered).toBe(true);
    expect(await recoverPendingDeadLetters(deps)).toBe(0); // nothing left to do
    await ensureDeadLettered(deps, row, 3); // forced repeat still does not duplicate
    expect(await dlqEntries(s, id)).toHaveLength(1);
  }, 60_000);
});
