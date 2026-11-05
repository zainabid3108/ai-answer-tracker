import { createHash } from 'node:crypto';

export interface IdempotencyParts {
  tenantId: string;
  questionId: string;
  questionVersion: number;
  providerId: string;
  modelId: string;
  /** UTC calendar date, YYYY-MM-DD. */
  runDate: string;
  sampleIndex: number;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** UTC calendar date (YYYY-MM-DD) for an instant. */
export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * sha256 hex of tenantId|questionId|questionVersion|providerId|modelId|runDate|sampleIndex.
 * Hex output contains no ':' so it is safe as a BullMQ custom jobId.
 * Components containing '|' are rejected so distinct tuples can never collide by concatenation.
 */
export function computeIdempotencyKey(p: IdempotencyParts): string {
  if (!DATE_RE.test(p.runDate)) throw new Error('runDate must be YYYY-MM-DD (UTC)');
  if (!Number.isInteger(p.sampleIndex) || p.sampleIndex < 0) throw new Error('sampleIndex must be a non-negative integer');
  if (!Number.isInteger(p.questionVersion) || p.questionVersion < 1) throw new Error('questionVersion must be a positive integer');
  const parts = [p.tenantId, p.questionId, String(p.questionVersion), p.providerId, p.modelId, p.runDate, String(p.sampleIndex)];
  for (const part of parts) {
    if (!part || part.includes('|')) throw new Error('idempotency components must be non-empty and must not contain "|"');
  }
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

/** Stable question identity: tenant-scoped hash of whitespace-collapsed, NFC-normalized text. */
export function deriveQuestionId(tenantId: string, questionText: string): string {
  const norm = questionText.normalize('NFC').trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(`${tenantId}|${norm}`).digest('hex').slice(0, 32);
}
