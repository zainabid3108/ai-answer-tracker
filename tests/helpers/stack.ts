import { randomUUID } from 'node:crypto';
import net from 'node:net';
import type { ConnectionOptions, Worker } from 'bullmq';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createApp, type AppDeps } from '../../src/api/app.js';
import type { BrandLimits } from '../../src/domain/brands.js';
import { createStaticKeyResolver } from '../../src/api/middleware/auth.js';
import { ensureIndexes } from '../../src/db/indexes.js';
import { connectMongo, type MongoHandle } from '../../src/db/mongo.js';
import { createRepositories, type Repositories } from '../../src/db/repositories/index.js';
import { createLogger } from '../../src/observability/logger.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { createProviderRegistry, type ProviderRegistry } from '../../src/providers/registry.js';
import { DLQ_NAME, QueueManager, type DeadLetterSink, llmQueueName, parseRedisUrl } from '../../src/queue/queues.js';
import { QuestionService } from '../../src/services/questionService.js';
import { startLlmWorker } from '../../src/workers/llmWorker.js';

export const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';

/** Fast TCP probe so infra-dependent suites can be skipped (and reported) when Redis is absent. */
export function isRedisUp(url = REDIS_URL): Promise<boolean> {
  const u = new URL(url);
  return new Promise((resolve) => {
    const s = net.connect({ host: u.hostname, port: Number(u.port || 6379) });
    const done = (ok: boolean) => { s.destroy(); resolve(ok); };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

/** Parses REQUIRE_REDIS strictly: unset/'false' => false, 'true' => true, anything else is an error (never silently skip). */
export function parseRequireRedis(raw: string | undefined): boolean {
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('REQUIRE_REDIS must be "true" or "false" when set');
}

/**
 * Decides whether Redis-backed suites run. Redis reachable -> true.
 * Unreachable: REQUIRE_REDIS=true -> throws (the suite file FAILS with a clear error);
 * otherwise warns and returns false so the suites are skipped (local dev without Redis).
 */
export async function resolveRedisAvailability(
  opts: { url?: string; require?: boolean; probe?: (url: string) => Promise<boolean> } = {},
): Promise<boolean> {
  const url = opts.url ?? REDIS_URL;
  const required = opts.require ?? parseRequireRedis(process.env.REQUIRE_REDIS);
  if (await (opts.probe ?? isRedisUp)(url)) return true;
  const where = `${new URL(url).hostname}:${new URL(url).port || 6379}`; // host:port only - never credentials
  if (required) {
    throw new Error(`REQUIRE_REDIS=true but Redis is unreachable at ${where}; integration suites cannot be skipped. Start Redis or unset REQUIRE_REDIS.`);
  }
  console.warn(`[tests] Redis unreachable at ${where}: skipping Redis-backed integration suites (set REQUIRE_REDIS=true to fail instead).`);
  return false;
}

export const TEST_DEFS = [
  { providerId: 'mock-alpha', adapter: 'mock' as const, enabled: true, models: ['mock-alpha-1'] },
  { providerId: 'mock-beta', adapter: 'mock' as const, enabled: true, models: ['mock-beta-1'] },
];

export interface Stack {
  repos: Repositories;
  registry: ProviderRegistry;
  queues: QueueManager;
  service: QuestionService;
  app: ReturnType<typeof createApp>;
  workers: Worker[];
  mongo: MongoHandle;
  prefix: string;
  connection: ConnectionOptions;
  /** Starts the real workers (no-op if already started). Used when a test needs to control the first delivery. */
  startWorkers(): Promise<void>;
  provider(id: string): MockProvider;
  stop(): Promise<void>;
}

export interface StackOptions {
  mongoUri: string;
  syncWaitMs?: number;
  maxAttempts?: number;
  providerTimeoutMs?: number;
  maxRateLimitHits?: number;
  /** Default true. false => nothing consumes the queues until stack.startWorkers(). */
  startWorkers?: boolean;
  lockDurationMs?: number;
  stalledIntervalMs?: number;
  staleRunningMs?: number;
  /** Wrap repositories handed to the WORKERS (fault injection). The API/service keep the real ones. */
  wrapWorkerRepos?: (repos: Repositories) => Repositories;
  /** Wrap the DLQ sink handed to the workers (fault injection). */
  wrapDeadLetter?: (q: QueueManager) => DeadLetterSink;
  protection?: AppDeps['protection'];
  limits?: AppDeps['limits'];
  brandLimits?: BrandLimits;
}

export const API_KEYS: Array<[string, string]> = [['key-a', 'tenant-a'], ['key-b', 'tenant-b']];

/** Real Mongo (memory server), real Redis/BullMQ with a unique prefix, mock providers, fast retry timings. */
export async function createStack(o: StackOptions): Promise<Stack> {
  const prefix = `aat-test-${randomUUID().slice(0, 8)}`;
  const logger = createLogger('silent');
  const mongo = await connectMongo(o.mongoUri, `t_${randomUUID().slice(0, 8)}`);
  await ensureIndexes(mongo.db);
  const repos = createRepositories(mongo.db);
  const connection = parseRedisUrl(REDIS_URL);
  const maxAttempts = o.maxAttempts ?? 3;
  const providerTimeoutMs = o.providerTimeoutMs ?? 300;
  const staleRunningMs = o.staleRunningMs ?? 10_000;
  const queues = new QueueManager({ connection, prefix, maxAttempts, backoffBaseMs: 40 });
  const registry = createProviderRegistry({ definitions: TEST_DEFS, allowFailureInjection: true });

  const workers: Worker[] = [];
  const startWorkers = async () => {
    if (workers.length) return;
    for (const d of registry.listEnabled()) {
      workers.push(
        startLlmWorker(
          {
            repos: o.wrapWorkerRepos ? o.wrapWorkerRepos(repos) : repos,
            registry,
            deadLetter: o.wrapDeadLetter ? o.wrapDeadLetter(queues) : queues,
            logger,
            providerTimeoutMs,
            maxRateLimitHits: o.maxRateLimitHits ?? 5,
            staleRunningMs,
          },
          {
            providerId: d.providerId, connection, prefix, concurrency: 3, lockDurationMs: o.lockDurationMs ?? 3000, backoffMaxMs: 200,
            ...(o.stalledIntervalMs ? { stalledIntervalMs: o.stalledIntervalMs } : {}),
          },
        ),
      );
    }
    await Promise.all(workers.map((w) => w.waitUntilReady()));
  };
  if (o.startWorkers !== false) await startWorkers();

  const service = new QuestionService({
    repos, registry, enqueuer: queues, logger, syncWaitMs: o.syncWaitMs ?? 8000, pollIntervalMs: 20, staleRunningMs,
    ...(o.brandLimits ? { brandLimits: o.brandLimits } : {}),
  });
  const app = createApp({
    logger,
    resolveApiKey: createStaticKeyResolver(API_KEYS),
    questions: service,
    ...(o.protection ? { protection: o.protection } : {}),
    ...(o.limits ? { limits: o.limits } : {}),
    readiness: [
      { name: 'mongo', check: async () => void (await mongo.db.command({ ping: 1 })) },
      { name: 'redis', check: () => queues.ping() },
    ],
  });

  return {
    repos, registry, queues, service, app, workers, mongo, prefix, connection, startWorkers,
    provider: (id) => registry.getProvider(id) as MockProvider,
    async stop() {
      await Promise.all(workers.map((w) => w.close(true).catch(() => undefined)));
      for (const name of [...registry.listEnabled().map((d) => llmQueueName(d.providerId)), DLQ_NAME]) {
        await queues.queue(name).obliterate({ force: true }).catch(() => undefined);
      }
      await queues.close();
      await mongo.db.dropDatabase().catch(() => undefined);
      await mongo.close();
    },
  };
}

/** Poll until fn returns a truthy value (or time out with a clear error). */
export async function waitFor<T>(fn: () => Promise<T | undefined | null | false>, timeoutMs = 15_000, intervalMs = 50): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export async function startMongo(): Promise<MongoMemoryServer> {
  return MongoMemoryServer.create();
}
