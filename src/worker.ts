import { loadEnv } from './config/env.js';
import { bootstrapRuntime } from './config/runtime.js';
import { connectMongo } from './db/mongo.js';
import { ensureIndexes } from './db/indexes.js';
import { createRepositories } from './db/repositories/index.js';
import { createLogger } from './observability/logger.js';
import { QueueManager, parseRedisUrl } from './queue/queues.js';
import { recoverPendingDeadLetters, startLlmWorker } from './workers/llmWorker.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  // Same shared safety checks as the API (before any connection).
  const { registry } = bootstrapRuntime(env, 'worker', logger);
  const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureIndexes(mongo.db);
  const repos = createRepositories(mongo.db);
  const connection = parseRedisUrl(env.REDIS_URL);
  const queues = new QueueManager({ connection, prefix: env.QUEUE_PREFIX, maxAttempts: env.MAX_ATTEMPTS, backoffBaseMs: env.BACKOFF_BASE_MS });

  const workers = registry.listEnabled().map((def) =>
    startLlmWorker(
      {
        repos,
        registry,
        deadLetter: queues,
        logger,
        providerTimeoutMs: env.PROVIDER_TIMEOUT_MS,
        maxRateLimitHits: env.MAX_RATE_LIMIT_HITS,
        staleRunningMs: env.LOCK_DURATION_MS * 2,
      },
      { providerId: def.providerId, connection, prefix: env.QUEUE_PREFIX, concurrency: env.WORKER_CONCURRENCY, lockDurationMs: env.LOCK_DURATION_MS, backoffMaxMs: env.BACKOFF_MAX_MS },
    ),
  );
  // Repair failed rows whose DLQ entry was never confirmed (DLQ outage / crash between ledger write and DLQ add).
  const sweep = () => recoverPendingDeadLetters({ repos, deadLetter: queues, logger }).catch((e) => logger.error({ err: (e as Error).message }, 'dead_letter_sweep_failed'));
  void sweep();
  const sweepTimer = setInterval(() => void sweep(), 60_000);
  sweepTimer.unref();
  logger.info({ providers: registry.listEnabled().map((d) => d.providerId) }, 'workers_started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'worker_shutting_down');
    await Promise.all(workers.map((w) => w.close()));
    await queues.close();
    await mongo.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('fatal startup error:', err instanceof Error ? err.message : 'unknown');
  process.exit(1);
});
