import { createApp } from './api/app.js';
import { createStaticKeyResolver } from './api/middleware/auth.js';
import { loadEnv } from './config/env.js';
import { bootstrapRuntime, brandLimitsFromEnv } from './config/runtime.js';
import { connectMongo } from './db/mongo.js';
import { ensureIndexes } from './db/indexes.js';
import { createRepositories } from './db/repositories/index.js';
import { createLogger } from './observability/logger.js';
import { QueueManager, parseRedisUrl } from './queue/queues.js';
import { QuestionService } from './services/questionService.js';

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  // Safety checks first (before any connection): production/mock guard, API key rules, injection flag, real-mode adapters.
  const { config, registry } = bootstrapRuntime(env, 'api', logger);
  const mongo = await connectMongo(env.MONGO_URL, env.MONGO_DB);
  await ensureIndexes(mongo.db);
  const repos = createRepositories(mongo.db);
  const queues = new QueueManager({
    connection: parseRedisUrl(env.REDIS_URL),
    prefix: env.QUEUE_PREFIX,
    maxAttempts: env.MAX_ATTEMPTS,
    backoffBaseMs: env.BACKOFF_BASE_MS,
  });
  const brandLimits = brandLimitsFromEnv(env);
  const questions = new QuestionService({
    repos, registry, enqueuer: queues, logger,
    syncWaitMs: env.API_SYNC_WAIT_MS,
    staleRunningMs: env.LOCK_DURATION_MS * 2, // must match the worker
    brandLimits,
    maxTargetsPerRequest: env.MAX_TARGETS_PER_REQUEST,
  });

  const app = createApp({
    logger,
    resolveApiKey: createStaticKeyResolver(config.apiKeys),
    limits: { maxQuestionChars: env.MAX_QUESTION_CHARS, brand: brandLimits },
    protection: {
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      maxRequestsPerTenant: env.RATE_LIMIT_MAX_PER_TENANT,
      maxUnauthPerIp: env.RATE_LIMIT_MAX_UNAUTH_PER_IP,
      maxInflightWaitsPerTenant: env.MAX_INFLIGHT_WAITS_PER_TENANT,
      maxInflightWaitsGlobal: env.MAX_INFLIGHT_WAITS_GLOBAL,
      bodyLimitBytes: env.BODY_LIMIT_BYTES,
    },
    questions,
    readiness: [
      { name: 'mongo', check: async () => void (await mongo.db.command({ ping: 1 })) },
      { name: 'redis', check: () => queues.ping() },
    ],
  });

  const server = app.listen(env.PORT, () => logger.info({ port: env.PORT }, 'api_listening'));
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'api_shutting_down');
    server.close();
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
