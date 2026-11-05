import { randomUUID } from 'node:crypto';
import { DelayedError, UnrecoverableError, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { computeBackoffMs } from '../domain/retry.js';
import { analyzeBrands } from '../domain/brandMatcher.js';
import { normalizeCitations } from '../domain/citations.js';
import type { AnswerRequest } from '../domain/types.js';
import type { Repositories } from '../db/repositories/index.js';
import type { Logger } from '../observability/logger.js';
import { ProviderError, parseProviderResponse } from '../providers/types.js';
import type { ProviderRegistry } from '../providers/registry.js';
import { LlmJobDataSchema, llmQueueName, type DeadLetterSink, type LlmJobData } from '../queue/queues.js';

export interface LlmProcessorDeps {
  repos: Repositories;
  registry: ProviderRegistry;
  deadLetter: DeadLetterSink;
  logger: Logger;
  providerTimeoutMs: number;
  maxRateLimitHits: number;
  /** Used when a 429 carries no Retry-After. */
  defaultRateLimitMs?: number;
  /** A 'running' row older than this is considered orphaned (must exceed lock duration). */
  staleRunningMs: number;
  /** Late-bound so the processor can call worker.rateLimit(). */
  getWorker: () => Worker | undefined;
}

export type ProcessOutcome = 'succeeded' | 'skipped';

async function callWithTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ac.abort();
      reject(new ProviderError('timeout', `Provider call exceeded ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(ac.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export interface DeadLetterRecoveryDeps {
  repos: Repositories;
  deadLetter: DeadLetterSink;
  logger: Logger;
}

/**
 * Writes the DLQ entry for a ledger row that is already 'failed', then confirms it on the ledger.
 * Idempotent: the DLQ jobId is the row's idempotency hash, so repeating it never duplicates the entry.
 */
export async function ensureDeadLettered(deps: DeadLetterRecoveryDeps, row: AnswerRequest, attempts: number): Promise<void> {
  await deps.deadLetter.deadLetter(row.idempotencyKey, {
    tenantId: row.tenantId,
    requestId: row._id,
    providerId: row.providerId,
    errorClass: row.errorClass ?? 'internal_error',
    attempts,
  });
  await deps.repos.requests.markDeadLettered(row.tenantId, row._id);
}

/**
 * Sweep for failed ledger rows whose DLQ entry was never confirmed (the DLQ write or the confirmation
 * threw and the job's own retries ran out). Safe to run repeatedly and from several workers.
 * Returns how many rows were repaired.
 */
export async function recoverPendingDeadLetters(deps: DeadLetterRecoveryDeps, limit = 100): Promise<number> {
  const rows = await deps.repos.requests.listPendingDeadLetters(limit);
  let repaired = 0;
  for (const row of rows) {
    try {
      await ensureDeadLettered(deps, row, row.attempts + 1);
      repaired++;
      deps.logger.warn({ tenantId: row.tenantId, requestId: row._id }, 'dead_letter_recovered');
    } catch (err) {
      deps.logger.error({ tenantId: row.tenantId, requestId: row._id, err: (err as Error).message }, 'dead_letter_recovery_failed');
    }
  }
  return repaired;
}

/** Thin job handler: claim -> call provider -> normalize -> persist -> mark status. */
export function createLlmProcessor(deps: LlmProcessorDeps) {
  const { repos, registry, logger } = deps;

  return async function process(job: Job<LlmJobData>, token?: string): Promise<ProcessOutcome> {
    const parsed = LlmJobDataSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid_job_payload');
    const { tenantId, requestId } = parsed.data;
    const jobId = String(job.id);
    const ownerToken = token ?? job.token ?? randomUUID();
    const log = logger.child({ tenantId, requestId, jobId });

    const existing = await repos.requests.findById(tenantId, requestId);
    if (!existing) throw new UnrecoverableError('request_not_found');
    if (existing.status === 'succeeded' || existing.status === 'failed') return skipTerminal(existing);

    const req = await repos.requests.claim(tenantId, requestId, { jobId, token: ownerToken, staleBefore: new Date(Date.now() - deps.staleRunningMs) });
    if (!req) {
      const cur = await repos.requests.findById(tenantId, requestId);
      if (!cur) throw new UnrecoverableError('request_not_found');
      if (cur.status === 'succeeded' || cur.status === 'failed') return skipTerminal(cur);
      if (cur.status === 'running') {
        // Fresh 'running' row owned by a different job: NEVER report success/skip (that would end this job and,
        // if the owner is dead, strand the row). Park the job until the row would count as stale, then re-check.
        const staleAt = (cur.startedAt?.getTime() ?? Date.now()) + deps.staleRunningMs;
        const delayMs = Math.min(deps.staleRunningMs, Math.max(250, staleAt - Date.now() + 100));
        log.warn({ ownerJobId: cur.ownerJobId, delayMs }, 'claim_conflict_delayed');
        if (token && typeof job.moveToDelayed === 'function') {
          await job.moveToDelayed(Date.now() + delayMs, token);
          throw new DelayedError();
        }
        throw new Error('request_owned_by_another_delivery'); // retryable fallback (consumes an attempt)
      }
      // queued again between our claim and read (lost a race): retry shortly
      throw new Error('claim_lost_race');
    }

    const maxAttempts = job.opts.attempts ?? 1;
    const attemptNo = job.attemptsMade + 1;
    const started = performance.now();
    if (existing.status === 'running') log.warn({ attempt: attemptNo }, 'reclaimed_own_running_row');

    try {
      const provider = registry.getProvider(req.providerId);
      if (!provider) throw new ProviderError('bad_request', 'Unknown provider');

      const raw = await callWithTimeout(deps.providerTimeoutMs, (signal) =>
        provider.generate({ prompt: req.questionText, modelId: req.modelId, requestKey: req.idempotencyKey, signal }),
      );
      const latencyMs = Math.round(performance.now() - started);
      const response = parseProviderResponse(raw);

      const text = response.text.normalize('NFC');
      const { mentions, truncated } = analyzeBrands(text, req.brands);
      const citations = normalizeCitations(response.citations, text);

      // Each write is an upsert keyed by (tenantId, requestId[, x]); a retry after a partial write is safe.
      const answer = await repos.answers.saveForRequest(tenantId, {
        requestId,
        providerId: req.providerId,
        modelId: req.modelId,
        runDate: req.runDate,
        text,
        usage: response.usage,
        latencyMs,
        ...(truncated ? { analysisTruncated: true } : {}),
      });
      await repos.mentions.saveForRequest(tenantId, requestId, answer._id, mentions);
      await repos.citations.saveForRequest(tenantId, requestId, answer._id, citations);
      const applied = await repos.requests.markSucceeded(tenantId, requestId, answer._id, ownerToken);
      if (!applied) {
        // Ownership was lost (another delivery reclaimed the row) or the row is already terminal.
        log.warn({ attempt: attemptNo }, 'ledger_update_not_applied_markSucceeded');
        return 'skipped';
      }

      log.info(
        { providerId: req.providerId, modelId: req.modelId, latencyMs, attempt: attemptNo, mentions: mentions.length, citations: citations.length, truncated },
        'request_succeeded',
      );
      return 'succeeded';
    } catch (err) {
      return handleFailure(err);
    }

    async function handleFailure(err: unknown): Promise<never> {
      const perr = err instanceof ProviderError ? err : undefined;
      const errorClass = perr?.kind ?? 'internal_error';
      const retryable = perr ? perr.retryable : true;
      const base = { providerId: req!.providerId, modelId: req!.modelId, errorClass, attempt: attemptNo, maxAttempts };

      // 429: defer without burning an attempt, pausing this provider's queue for Retry-After.
      const worker = deps.getWorker();
      if (perr?.kind === 'rate_limited' && worker && req!.rateLimitHits < deps.maxRateLimitHits) {
        const waitMs = perr.retryAfterMs ?? deps.defaultRateLimitMs ?? 1000;
        await tryLedger('requeue', () => repos.requests.requeue(tenantId, requestId, errorClass, false, ownerToken));
        log.warn({ ...base, retryAfterMs: waitMs, rateLimitHits: req!.rateLimitHits + 1 }, 'request_rate_limited');
        await worker.rateLimit(waitMs);
        throw Worker.RateLimitError();
      }

      const exhausted = attemptNo >= maxAttempts || perr?.kind === 'rate_limited';
      if (retryable && !exhausted) {
        // If the ledger write fails the row stays 'running' under this job id; BullMQ's redelivery of the
        // same job can reclaim it (ownerJobId match), so a Mongo blip here cannot strand the request.
        await tryLedger('requeue', () => repos.requests.requeue(tenantId, requestId, errorClass, true, ownerToken));
        log.warn(base, 'request_retry_scheduled');
        throw err instanceof Error ? err : new Error(errorClass);
      }

      // Final failure: ledger first (source of truth), then DLQ (recoverable if it fails; see ensureDeadLettered).
      let marked: boolean;
      try {
        marked = await repos.requests.markFailed(tenantId, requestId, errorClass, ownerToken);
      } catch (e) {
        log.error({ ...base, err: (e as Error).message }, 'ledger_write_failed_markFailed');
        throw e; // plain error: BullMQ retries the job while attempts remain; row is still reclaimable
      }
      if (!marked) {
        log.warn(base, 'ledger_update_not_applied_markFailed');
        const cur = await repos.requests.findById(tenantId, requestId);
        if (cur?.status === 'failed' && cur.deadLettered === false) {
          await ensureDeadLettered({ repos, deadLetter: deps.deadLetter, logger }, cur, attemptNo);
        }
        throw new UnrecoverableError(errorClass);
      }
      try {
        await ensureDeadLettered(
          { repos, deadLetter: deps.deadLetter, logger },
          { ...req!, status: 'failed', errorClass },
          attemptNo,
        );
      } catch (e) {
        // Ledger already says 'failed'. A plain (retryable) error makes BullMQ redeliver while attempts
        // remain -> skipTerminal() writes the DLQ entry; otherwise the recovery sweep picks it up.
        log.error({ ...base, err: (e as Error).message }, 'dead_letter_write_failed');
        throw e;
      }
      log.error({ ...base, retryable }, 'request_failed_final');
      throw new UnrecoverableError(errorClass);
    }

    async function tryLedger(name: string, fn: () => Promise<boolean>): Promise<void> {
      try {
        if (!(await fn())) log.warn({ attempt: attemptNo }, `ledger_update_not_applied_${name}`);
      } catch (e) {
        log.error({ attempt: attemptNo, err: (e as Error).message }, `ledger_write_failed_${name}`);
      }
    }

    async function skipTerminal(row: AnswerRequest): Promise<ProcessOutcome> {
      log.info({ status: row.status }, 'skip_terminal_request');
      if (row.status === 'failed' && row.deadLettered === false) {
        // A previous delivery marked the row failed but the DLQ write/confirmation did not complete.
        await ensureDeadLettered({ repos, deadLetter: deps.deadLetter, logger }, row, row.attempts + 1);
        log.warn('dead_letter_recovered');
      }
      return 'skipped';
    }
  };
}

export interface StartLlmWorkerOptions {
  providerId: string;
  connection: ConnectionOptions;
  prefix: string;
  concurrency: number;
  /** Must be greater than providerTimeoutMs. */
  lockDurationMs: number;
  backoffMaxMs: number;
  /** Test hook: deterministic jitter. */
  rng?: () => number;
  /** Test hook: override BullMQ's stalled-job check interval (default 30s). */
  stalledIntervalMs?: number;
}

export function startLlmWorker(deps: Omit<LlmProcessorDeps, 'getWorker'>, opts: StartLlmWorkerOptions): Worker {
  if (opts.lockDurationMs <= deps.providerTimeoutMs) throw new Error('lockDurationMs must exceed providerTimeoutMs');
  let worker: Worker | undefined;
  const processor = createLlmProcessor({ ...deps, getWorker: () => worker });
  worker = new Worker(llmQueueName(opts.providerId), processor, {
    connection: opts.connection,
    prefix: opts.prefix,
    concurrency: opts.concurrency,
    lockDuration: opts.lockDurationMs,
    ...(opts.stalledIntervalMs ? { stalledInterval: opts.stalledIntervalMs } : {}),
    settings: {
      backoffStrategy: (attemptsMade, type, _err, job) => {
        if (type !== 'expJitter') return 0;
        const b = job?.opts.backoff;
        const base = typeof b === 'object' && b.delay ? b.delay : 1000;
        return computeBackoffMs(attemptsMade, base, opts.backoffMaxMs, opts.rng);
      },
    },
  });
  worker.on('error', (e) => deps.logger.error({ providerId: opts.providerId, err: e.message }, 'worker_error'));
  return worker;
}
