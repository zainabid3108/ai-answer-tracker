import { randomUUID } from 'node:crypto';
import { MongoServerError, type Collection, type Db } from 'mongodb';
import type { AnswerRequest, Brand, RequestStatus } from '../../domain/types.js';
import { COLLECTIONS } from '../indexes.js';
import { assertTenant } from './tenant.js';

export interface NewRequest {
  idempotencyKey: string;
  questionId: string;
  questionVersion: number;
  questionText: string;
  brands: Brand[];
  brandsHash: string;
  providerId: string;
  modelId: string;
  runDate: string;
  sampleIndex: number;
}

export interface ClaimOptions {
  /** BullMQ job id of this delivery (stable across redeliveries of the same job). */
  jobId: string;
  /** Unique per delivery (BullMQ lock token); fences zombie writers. */
  token: string;
  /** A 'running' row started before this instant is considered orphaned. */
  staleBefore: Date;
}

export class AnswerRequestRepository {
  private readonly col: Collection<AnswerRequest>;

  constructor(db: Db, private readonly now: () => Date = () => new Date()) {
    this.col = db.collection<AnswerRequest>(COLLECTIONS.requests);
  }

  /** Insert-or-get keyed by the unique (tenantId, idempotencyKey) index. First insert wins. */
  async createOrGet(tenantId: string, input: NewRequest): Promise<{ request: AnswerRequest; created: boolean }> {
    assertTenant(tenantId);
    const now = this.now();
    const doc: AnswerRequest = {
      _id: randomUUID(),
      tenantId,
      ...input,
      status: 'queued',
      attempts: 0,
      rateLimitHits: 0,
      enqueueEpoch: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.col.insertOne(doc);
      return { request: doc, created: true };
    } catch (err) {
      if (err instanceof MongoServerError && err.code === 11000) {
        const existing = await this.col.findOne({ tenantId, idempotencyKey: input.idempotencyKey });
        if (existing) return { request: existing, created: false };
      }
      throw err;
    }
  }

  async findById(tenantId: string, requestId: string): Promise<AnswerRequest | null> {
    assertTenant(tenantId);
    return this.col.findOne({ _id: requestId, tenantId });
  }

  async findByKeys(tenantId: string, idempotencyKeys: string[]): Promise<AnswerRequest[]> {
    assertTenant(tenantId);
    if (idempotencyKeys.length === 0) return [];
    return this.col.find({ tenantId, idempotencyKey: { $in: idempotencyKeys } }).toArray();
  }

  /** Cheap polling read: ids and statuses only (no brands snapshot, no question text). */
  async findStatuses(tenantId: string, requestIds: string[]): Promise<Array<{ _id: string; status: RequestStatus }>> {
    assertTenant(tenantId);
    if (requestIds.length === 0) return [];
    return this.col.find({ tenantId, _id: { $in: requestIds } }, { projection: { _id: 1, status: 1 } }).toArray() as Promise<
      Array<{ _id: string; status: RequestStatus }>
    >;
  }

  /**
   * Atomic claim. Succeeds when the row is
   *  - 'queued', or
   *  - 'running' and owned by the SAME job id (a redelivery after a stall / lost lock: the previous
   *    delivery is presumed dead and its token is fenced out), or
   *  - 'running' and stale (owner vanished, e.g. a replacement job after submit() re-enqueued it).
   * Returns null if it is terminal or freshly running under a different job.
   */
  async claim(tenantId: string, requestId: string, o: ClaimOptions): Promise<AnswerRequest | null> {
    assertTenant(tenantId);
    const now = this.now();
    return this.col.findOneAndUpdate(
      {
        _id: requestId,
        tenantId,
        $or: [{ status: 'queued' }, { status: 'running', ownerJobId: o.jobId }, { status: 'running', startedAt: { $lt: o.staleBefore } }],
      },
      { $set: { status: 'running', startedAt: now, updatedAt: now, ownerJobId: o.jobId, ownerToken: o.token } },
      { returnDocument: 'after' },
    );
  }

  /** All ledger transitions below are fenced by the owner token of the claiming delivery. */
  async markSucceeded(tenantId: string, requestId: string, answerId: string, ownerToken: string): Promise<boolean> {
    assertTenant(tenantId);
    const now = this.now();
    const r = await this.col.updateOne(
      { _id: requestId, tenantId, status: 'running', ownerToken },
      { $set: { status: 'succeeded', answerId, finishedAt: now, updatedAt: now }, $unset: { errorClass: '', ownerToken: '', ownerJobId: '' } },
    );
    return r.modifiedCount === 1;
  }

  /** Marks failed and flags the dead-letter entry as still owed (deadLettered=false) until markDeadLettered. */
  async markFailed(tenantId: string, requestId: string, errorClass: string, ownerToken: string): Promise<boolean> {
    assertTenant(tenantId);
    const now = this.now();
    const r = await this.col.updateOne(
      { _id: requestId, tenantId, status: 'running', ownerToken },
      { $set: { status: 'failed', errorClass, finishedAt: now, updatedAt: now, deadLettered: false }, $unset: { ownerToken: '', ownerJobId: '' } },
    );
    return r.modifiedCount === 1;
  }

  async markDeadLettered(tenantId: string, requestId: string): Promise<boolean> {
    assertTenant(tenantId);
    const r = await this.col.updateOne({ _id: requestId, tenantId, status: 'failed' }, { $set: { deadLettered: true, updatedAt: this.now() } });
    return r.modifiedCount === 1;
  }

  /**
   * SYSTEM-level (cross-tenant) scan used only by the dead-letter recovery sweep: failed rows whose
   * DLQ entry is not confirmed written. Returned rows are then handled strictly per tenant.
   */
  async listPendingDeadLetters(limit: number): Promise<AnswerRequest[]> {
    return this.col.find({ status: 'failed', deadLettered: false }).limit(limit).toArray();
  }

  /** running -> queued for another try. `burnAttempt` false for 429 deferrals. */
  async requeue(tenantId: string, requestId: string, errorClass: string, burnAttempt: boolean, ownerToken: string): Promise<boolean> {
    assertTenant(tenantId);
    const r = await this.col.updateOne(
      { _id: requestId, tenantId, status: 'running', ownerToken },
      {
        $set: { status: 'queued', errorClass, updatedAt: this.now() },
        $unset: { ownerToken: '', ownerJobId: '' },
        $inc: burnAttempt ? { attempts: 1 } : { rateLimitHits: 1 },
      },
    );
    return r.modifiedCount === 1;
  }

  /**
   * Atomically turns a stale 'running' row back into 'queued' and bumps its enqueue epoch. Exactly one
   * concurrent caller gets the updated row back; it must then enqueue a job under the epoch-specific id.
   */
  async reclaimStale(tenantId: string, requestId: string, staleBefore: Date): Promise<AnswerRequest | null> {
    assertTenant(tenantId);
    return this.col.findOneAndUpdate(
      { _id: requestId, tenantId, status: 'running', startedAt: { $lt: staleBefore } },
      { $set: { status: 'queued', updatedAt: this.now() }, $unset: { ownerToken: '', ownerJobId: '' }, $inc: { enqueueEpoch: 1 } },
      { returnDocument: 'after' },
    );
  }
}
