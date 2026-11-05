import type { Db } from 'mongodb';

export const COLLECTIONS = {
  requests: 'answer_requests',
  answers: 'answers',
  mentions: 'mentions',
  citations: 'citations',
  brands: 'brands',
} as const;

/**
 * Idempotent index creation. The unique index on (tenantId, idempotencyKey) is THE duplicate-processing
 * guarantee; every other unique index makes the persistence steps safely repeatable on retries.
 */
export async function ensureIndexes(db: Db): Promise<void> {
  await db.collection(COLLECTIONS.requests).createIndexes([
    { key: { tenantId: 1, idempotencyKey: 1 }, unique: true, name: 'uniq_tenant_idempotency' },
    { key: { tenantId: 1, status: 1, updatedAt: 1 }, name: 'tenant_status_updated' },
    // Dead-letter recovery sweep: tiny partial index over failed rows whose DLQ entry is still owed.
    { key: { deadLettered: 1 }, name: 'pending_dead_letters', partialFilterExpression: { deadLettered: false } },
  ]);
  await db.collection(COLLECTIONS.answers).createIndexes([
    { key: { tenantId: 1, requestId: 1 }, unique: true, name: 'uniq_tenant_request' },
  ]);
  await db.collection(COLLECTIONS.mentions).createIndexes([
    { key: { tenantId: 1, requestId: 1, brandId: 1 }, unique: true, name: 'uniq_tenant_request_brand' },
  ]);
  await db.collection(COLLECTIONS.citations).createIndexes([
    { key: { tenantId: 1, requestId: 1, normalizedUrl: 1 }, unique: true, name: 'uniq_tenant_request_url' },
  ]);
  await db.collection(COLLECTIONS.brands).createIndexes([
    { key: { tenantId: 1, brandId: 1 }, unique: true, name: 'uniq_tenant_brand' },
  ]);
}
