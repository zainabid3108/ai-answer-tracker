import type { Repositories } from '../db/repositories/index.js';
import {
  BrandValidationError,
  DEFAULT_BRAND_LIMITS,
  computeBrandsHash,
  normalizeBrands,
  type BrandInput,
  type BrandLimits,
} from '../domain/brands.js';
import { computeIdempotencyKey, deriveQuestionId, utcDateString } from '../domain/idempotency.js';
import type { AnswerRequest, Brand, BrandMention, RequestStatus, Usage } from '../domain/types.js';
import type { Logger } from '../observability/logger.js';
import type { ProviderRegistry } from '../providers/registry.js';
import type { JobEnqueuer } from '../queue/queues.js';

export type { BrandInput } from '../domain/brands.js';

export class ServiceError extends Error {
  constructor(
    readonly code: string,
    readonly httpStatus: number,
    message: string,
    /** Extra machine-readable fields merged into the error body (never secrets or brand contents). */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface SubmitInput {
  question: string;
  brands?: BrandInput[];
  providerId?: string;
  modelId?: string;
  questionVersion?: number;
}

export interface SubmitOptions {
  /** false => create/enqueue and return immediately (202) without the sync wait. Default true. */
  wait?: boolean;
  /** Aborts the sync wait early (client disconnected). */
  signal?: AbortSignal;
}

export interface RequestView {
  requestId: string;
  status: RequestStatus;
  providerId: string;
  modelId: string;
  runDate: string;
  /** Fingerprint of the brand snapshot this request was (and will be) analyzed against. */
  brandsHash: string;
  errorClass?: string;
  result?: {
    answer: string;
    brandMentions: BrandMention[];
    /** True when a matcher workload cap was hit; mention counts are then a lower bound. */
    truncated?: boolean;
    citations: Array<{ rawUrl: string; normalizedUrl: string; domain: string; title?: string }>;
    usage: Usage;
    latencyMs: number;
  };
}

export interface SubmitResult {
  questionId: string;
  /** True when every request reached a terminal state within the wait window. */
  complete: boolean;
  results: RequestView[];
}

export interface QuestionApi {
  submit(tenantId: string, input: SubmitInput, opts?: SubmitOptions): Promise<SubmitResult>;
  get(tenantId: string, requestId: string): Promise<RequestView | null>;
}

export interface QuestionServiceDeps {
  repos: Repositories;
  registry: ProviderRegistry;
  enqueuer: JobEnqueuer;
  logger: Logger;
  syncWaitMs: number;
  pollIntervalMs?: number;
  /** A 'running' row older than this may be re-enqueued by submit() (must match the worker's staleRunningMs). */
  staleRunningMs?: number;
  brandLimits?: BrandLimits;
  maxTargetsPerRequest?: number;
  now?: () => Date;
}

const isTerminal = (s: RequestStatus) => s === 'succeeded' || s === 'failed';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** epoch 0 keeps the original jobId (= idempotency hash); later epochs get a fresh id so a lingering dead job cannot block them. */
export const jobIdFor = (idempotencyKey: string, epoch: number | undefined) => (epoch ? `${idempotencyKey}-e${epoch}` : idempotencyKey);

export class QuestionService implements QuestionApi {
  private readonly now: () => Date;
  private readonly poll: number;
  private readonly staleRunningMs: number;
  private readonly brandLimits: BrandLimits;
  private readonly maxTargets: number;

  constructor(private readonly deps: QuestionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.poll = deps.pollIntervalMs ?? 100;
    this.staleRunningMs = deps.staleRunningMs ?? 70_000;
    this.brandLimits = deps.brandLimits ?? DEFAULT_BRAND_LIMITS;
    this.maxTargets = deps.maxTargetsPerRequest ?? 20;
  }

  async submit(tenantId: string, input: SubmitInput, opts: SubmitOptions = {}): Promise<SubmitResult> {
    const { repos, registry, enqueuer, logger } = this.deps;
    const targets = registry.resolve(input.providerId, input.modelId);
    if (!targets || targets.length === 0) throw new ServiceError('unknown_provider_or_model', 400, 'Unknown or disabled provider/model');
    if (targets.length > this.maxTargets) {
      throw new ServiceError('too_many_targets', 400, `Selection resolves to ${targets.length} provider/model targets; the limit is ${this.maxTargets}`);
    }

    const inline = input.brands !== undefined;
    const brands = await this.resolveBrands(tenantId, input.brands);
    const brandsHash = computeBrandsHash(brands);
    const questionId = deriveQuestionId(tenantId, input.question);
    const questionVersion = input.questionVersion ?? 1;
    const runDate = utcDateString(this.now());
    const keys = targets.map((t) =>
      computeIdempotencyKey({ tenantId, questionId, questionVersion, providerId: t.providerId, modelId: t.modelId, runDate, sampleIndex: 0 }),
    );

    // Read-only pre-check so a conflicting resubmission creates no new work for the other targets.
    for (const row of await repos.requests.findByKeys(tenantId, keys)) this.assertSameSnapshot(row, brandsHash, questionVersion, inline);

    const requests: AnswerRequest[] = [];
    const conflicts: AnswerRequest[] = [];
    for (const [i, t] of targets.entries()) {
      const idempotencyKey = keys[i]!;
      // First insert wins (unique (tenantId, idempotencyKey)); a racing loser gets the winner's row back.
      const { request, created } = await repos.requests.createOrGet(tenantId, {
        idempotencyKey,
        questionId,
        questionVersion,
        questionText: input.question,
        brands,
        brandsHash,
        providerId: t.providerId,
        modelId: t.modelId,
        runDate,
        sampleIndex: 0,
      });
      if (!created && this.storedHash(request) !== brandsHash) {
        conflicts.push(request);
        continue;
      }

      let epoch = request.enqueueEpoch ?? 0;
      let needsEnqueue = created || request.status === 'queued';
      // Orphaned 'running' row (worker died and BullMQ gave up on the job): atomically hand it to one submitter.
      if (!created && request.status === 'running' && request.startedAt && request.startedAt.getTime() < this.now().getTime() - this.staleRunningMs) {
        const reclaimed = await repos.requests.reclaimStale(tenantId, request._id, new Date(this.now().getTime() - this.staleRunningMs));
        if (reclaimed) {
          epoch = reclaimed.enqueueEpoch ?? epoch + 1;
          needsEnqueue = true;
          logger.warn({ tenantId, requestId: request._id, epoch }, 'stale_running_request_reclaimed');
        }
      }
      // Re-add when queued: heals a crash between insert and enqueue. Same jobId => no-op if the job exists.
      if (needsEnqueue) {
        try {
          await enqueuer.enqueue({ providerId: t.providerId, jobId: jobIdFor(idempotencyKey, epoch), tenantId, requestId: request._id });
        } catch (err) {
          logger.error({ tenantId, requestId: request._id, err: (err as Error).message }, 'enqueue_failed');
          throw new ServiceError('queue_unavailable', 503, 'Could not enqueue request');
        }
      }
      logger.info({ tenantId, requestId: request._id, providerId: t.providerId, modelId: t.modelId, created }, 'request_accepted');
      requests.push(request);
    }
    if (conflicts.length > 0) this.assertSameSnapshot(conflicts[0]!, brandsHash, questionVersion, inline);

    const ids = requests.map((r) => r._id);
    if (opts.wait !== false) {
      // Poll cheap status-only reads; fetch the full view (answer, mentions, citations) once at the end.
      const deadline = Date.now() + this.deps.syncWaitMs;
      for (;;) {
        const statuses = await repos.requests.findStatuses(tenantId, ids);
        if (statuses.length === ids.length && statuses.every((s) => isTerminal(s.status))) break;
        if (Date.now() >= deadline || opts.signal?.aborted) break;
        await sleep(this.poll);
      }
    }
    const views = await this.viewAll(tenantId, ids);
    return { questionId, complete: views.length === ids.length && views.every((v) => isTerminal(v.status)), results: views };
  }

  async get(tenantId: string, requestId: string): Promise<RequestView | null> {
    const req = await this.deps.repos.requests.findById(tenantId, requestId);
    return req ? this.toView(tenantId, req) : null;
  }

  private storedHash(row: AnswerRequest): string {
    return row.brandsHash ?? computeBrandsHash(row.brands); // legacy rows predate the stored hash
  }

  private assertSameSnapshot(row: AnswerRequest, submittedHash: string, questionVersion: number, inline: boolean): void {
    const storedHash = this.storedHash(row);
    if (storedHash === submittedHash) return;
    throw new ServiceError(
      'brand_snapshot_conflict',
      409,
      inline
        ? 'This question was already submitted with a different brand set. Brands are snapshotted at first submission; send the original brand set or bump questionVersion to start a new run.'
        : "This question was already submitted and the tenant's brand list has changed since. Brands are snapshotted at first submission; bump questionVersion to start a new run.",
      { storedBrandsHash: storedHash, submittedBrandsHash: submittedHash, questionVersion },
    );
  }

  private async resolveBrands(tenantId: string, inline: BrandInput[] | undefined): Promise<Brand[]> {
    try {
      if (inline) return normalizeBrands(inline, this.brandLimits);
    } catch (err) {
      if (err instanceof BrandValidationError) throw new ServiceError(err.code, 400, err.message);
      throw err;
    }
    const stored = await this.deps.repos.brands.listByTenant(tenantId);
    try {
      return normalizeBrands(stored, this.brandLimits);
    } catch (err) {
      if (err instanceof BrandValidationError) {
        throw new ServiceError('tenant_brands_invalid', 422, `The tenant's stored brand configuration violates current limits (${err.code}); fix it or send brands inline`);
      }
      throw err;
    }
  }

  private async viewAll(tenantId: string, ids: string[]): Promise<RequestView[]> {
    const out: RequestView[] = [];
    for (const id of ids) {
      const v = await this.get(tenantId, id);
      if (v) out.push(v);
    }
    return out;
  }

  private async toView(tenantId: string, req: AnswerRequest): Promise<RequestView> {
    const view: RequestView = {
      requestId: req._id,
      status: req.status,
      providerId: req.providerId,
      modelId: req.modelId,
      runDate: req.runDate,
      brandsHash: this.storedHash(req),
    };
    if (req.errorClass && req.status === 'failed') view.errorClass = req.errorClass;
    if (req.status === 'succeeded') {
      const { repos } = this.deps;
      const [answer, mentions, citations] = await Promise.all([
        repos.answers.findByRequest(tenantId, req._id),
        repos.mentions.listByRequest(tenantId, req._id),
        repos.citations.listByRequest(tenantId, req._id),
      ]);
      if (answer) {
        view.result = {
          answer: answer.text,
          brandMentions: mentions.map(({ brandId, name, count, firstPosition, rank, snippet }) => ({ brandId, name, count, firstPosition, rank, snippet })),
          ...(answer.analysisTruncated ? { truncated: true } : {}),
          citations: citations.map((c) => ({ rawUrl: c.rawUrl, normalizedUrl: c.normalizedUrl, domain: c.domain, ...(c.title ? { title: c.title } : {}) })),
          usage: answer.usage,
          latencyMs: answer.latencyMs,
        };
      }
    }
    return view;
  }
}
