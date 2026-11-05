import type { Collection, Db } from 'mongodb';
import type { BrandMention } from '../../domain/types.js';
import { COLLECTIONS } from '../indexes.js';
import { assertTenant } from './tenant.js';

export interface StoredMention extends BrandMention {
  tenantId: string;
  requestId: string;
  answerId: string;
}

export class MentionRepository {
  private readonly col: Collection<StoredMention>;

  constructor(db: Db) {
    this.col = db.collection<StoredMention>(COLLECTIONS.mentions);
  }

  async saveForRequest(tenantId: string, requestId: string, answerId: string, mentions: BrandMention[]): Promise<void> {
    assertTenant(tenantId);
    if (mentions.length === 0) return;
    await this.col.bulkWrite(
      mentions.map((m) => ({
        replaceOne: {
          filter: { tenantId, requestId, brandId: m.brandId },
          replacement: { tenantId, requestId, answerId, ...m },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async listByRequest(tenantId: string, requestId: string): Promise<StoredMention[]> {
    assertTenant(tenantId);
    return this.col.find({ tenantId, requestId }).sort({ rank: 1 }).toArray();
  }
}
