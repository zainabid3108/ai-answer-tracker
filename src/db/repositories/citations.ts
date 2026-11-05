import type { Collection, Db } from 'mongodb';
import type { Citation } from '../../domain/types.js';
import { COLLECTIONS } from '../indexes.js';
import { assertTenant } from './tenant.js';

export interface StoredCitation extends Citation {
  tenantId: string;
  requestId: string;
  answerId: string;
}

export class CitationRepository {
  private readonly col: Collection<StoredCitation>;

  constructor(db: Db) {
    this.col = db.collection<StoredCitation>(COLLECTIONS.citations);
  }

  async saveForRequest(tenantId: string, requestId: string, answerId: string, citations: Citation[]): Promise<void> {
    assertTenant(tenantId);
    if (citations.length === 0) return;
    await this.col.bulkWrite(
      citations.map((c) => ({
        replaceOne: {
          filter: { tenantId, requestId, normalizedUrl: c.normalizedUrl },
          replacement: { tenantId, requestId, answerId, ...c },
          upsert: true,
        },
      })),
      { ordered: false },
    );
  }

  async listByRequest(tenantId: string, requestId: string): Promise<StoredCitation[]> {
    assertTenant(tenantId);
    return this.col.find({ tenantId, requestId }).sort({ position: 1 }).toArray();
  }
}
