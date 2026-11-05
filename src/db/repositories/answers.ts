import { randomUUID } from 'node:crypto';
import type { Collection, Db } from 'mongodb';
import type { StoredAnswer, Usage } from '../../domain/types.js';
import { COLLECTIONS } from '../indexes.js';
import { assertTenant } from './tenant.js';

export class AnswerRepository {
  private readonly col: Collection<StoredAnswer>;

  constructor(db: Db) {
    this.col = db.collection<StoredAnswer>(COLLECTIONS.answers);
  }

  /** Upsert keyed by (tenantId, requestId): repeating after a crash/retry never creates a second answer. */
  async saveForRequest(
    tenantId: string,
    a: { requestId: string; providerId: string; modelId: string; runDate: string; text: string; usage: Usage; latencyMs: number; analysisTruncated?: boolean },
  ): Promise<StoredAnswer> {
    assertTenant(tenantId);
    const doc = await this.col.findOneAndUpdate(
      { tenantId, requestId: a.requestId },
      { $setOnInsert: { _id: randomUUID(), tenantId, ...a, createdAt: new Date() } },
      { upsert: true, returnDocument: 'after' },
    );
    if (!doc) throw new Error('answer upsert returned no document');
    return doc;
  }

  async findByRequest(tenantId: string, requestId: string): Promise<StoredAnswer | null> {
    assertTenant(tenantId);
    return this.col.findOne({ tenantId, requestId });
  }

  async countByRequest(tenantId: string, requestId: string): Promise<number> {
    assertTenant(tenantId);
    return this.col.countDocuments({ tenantId, requestId });
  }
}
