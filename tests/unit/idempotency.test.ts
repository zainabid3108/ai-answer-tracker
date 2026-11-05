import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeIdempotencyKey, deriveQuestionId, utcDateString, type IdempotencyParts } from '../../src/domain/idempotency.js';
import { computeBackoffMs } from '../../src/domain/retry.js';

const base: IdempotencyParts = {
  tenantId: 't1', questionId: 'q1', questionVersion: 1, providerId: 'p', modelId: 'm', runDate: '2026-11-04', sampleIndex: 0,
};

describe('computeIdempotencyKey', () => {
  it('is sha256 of the pipe-joined tuple', () => {
    const expected = createHash('sha256').update('t1|q1|1|p|m|2026-11-04|0').digest('hex');
    expect(computeIdempotencyKey(base)).toBe(expected);
  });

  it('is deterministic, hex, and contains no colon (valid BullMQ jobId)', () => {
    const k = computeIdempotencyKey(base);
    expect(computeIdempotencyKey({ ...base })).toBe(k);
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k.includes(':')).toBe(false);
  });

  it.each([
    ['tenantId', { tenantId: 't2' }],
    ['questionId', { questionId: 'q2' }],
    ['questionVersion', { questionVersion: 2 }],
    ['providerId', { providerId: 'p2' }],
    ['modelId', { modelId: 'm2' }],
    ['runDate', { runDate: '2026-11-05' }],
    ['sampleIndex', { sampleIndex: 1 }],
  ])('changes when %s changes', (_n, patch) => {
    expect(computeIdempotencyKey({ ...base, ...patch })).not.toBe(computeIdempotencyKey(base));
  });

  it('rejects separators, empty parts and bad dates', () => {
    expect(() => computeIdempotencyKey({ ...base, tenantId: 'a|b' })).toThrow();
    expect(() => computeIdempotencyKey({ ...base, modelId: '' })).toThrow();
    expect(() => computeIdempotencyKey({ ...base, runDate: '04-11-2026' })).toThrow();
    expect(() => computeIdempotencyKey({ ...base, sampleIndex: -1 })).toThrow();
    expect(() => computeIdempotencyKey({ ...base, questionVersion: 0 })).toThrow();
  });
});

describe('utcDateString', () => {
  it('uses UTC, not local time', () => {
    expect(utcDateString(new Date('2026-11-04T23:59:59-05:00'))).toBe('2026-11-05');
    expect(utcDateString(new Date('2026-11-04T00:00:00Z'))).toBe('2026-11-04');
  });
});

describe('deriveQuestionId', () => {
  it('ignores whitespace and unicode normalization form, is tenant scoped', () => {
    expect(deriveQuestionId('t', ' best  CRM?\n')).toBe(deriveQuestionId('t', 'best CRM?'));
    expect(deriveQuestionId('t', 'café')).toBe(deriveQuestionId('t', 'café'));
    expect(deriveQuestionId('t1', 'x')).not.toBe(deriveQuestionId('t2', 'x'));
  });
});

describe('computeBackoffMs', () => {
  it('grows exponentially within [exp/2, exp] and respects the cap', () => {
    expect(computeBackoffMs(1, 1000, 60000, () => 0)).toBe(500);
    expect(computeBackoffMs(1, 1000, 60000, () => 0.999999)).toBe(999);
    expect(computeBackoffMs(3, 1000, 60000, () => 0)).toBe(2000);
    expect(computeBackoffMs(20, 1000, 60000, () => 0.5)).toBeLessThanOrEqual(60000);
    expect(computeBackoffMs(20, 1000, 60000, () => 0)).toBe(30000);
  });
  it('jitters between calls with a real rng', () => {
    const s = new Set(Array.from({ length: 20 }, () => computeBackoffMs(4, 1000, 60000)));
    expect(s.size).toBeGreaterThan(1);
  });
});
