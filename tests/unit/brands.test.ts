import { describe, expect, it } from 'vitest';
import { BrandValidationError, DEFAULT_BRAND_LIMITS, computeBrandsHash, deriveBrandId, normalizeBrands } from '../../src/domain/brands.js';

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return e instanceof BrandValidationError ? e.code : `other:${(e as Error).message}`;
  }
  return 'no-error';
};

describe('deriveBrandId (H2)', () => {
  it('keeps Unicode-distinct names distinct (no lossy ASCII slug)', () => {
    const names = ['Café', 'Cafe', 'Кафе', 'Кофе', '咖啡', '珈琲', 'قهوة', 'Zoë', 'Zoe', 'Acme', 'ACME Corp'];
    const ids = names.map(deriveBrandId);
    expect(new Set(ids).size).toBe(names.length);
    for (const id of ids) expect(id).toMatch(/^b_[0-9a-f]{24}$/);
  });

  it('is stable across NFC/NFD, case, and whitespace variants', () => {
    const nfc = 'Café Zürich';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(deriveBrandId(nfd)).toBe(deriveBrandId(nfc));
    expect(deriveBrandId('CAFÉ ZÜRICH')).toBe(deriveBrandId(nfc));
    expect(deriveBrandId('  Café   Zürich ')).toBe(deriveBrandId(nfc));
    expect(deriveBrandId('Кафе')).toBe(deriveBrandId('КАФЕ'));
  });
});

describe('normalizeBrands (H2)', () => {
  it('accepts many distinct non-Latin brands without id collisions', () => {
    const out = normalizeBrands([{ name: 'Кафе' }, { name: '咖啡' }, { name: 'قهوة' }, { name: 'Café' }, { name: 'Cafe' }]);
    expect(new Set(out.map((b) => b.brandId)).size).toBe(5);
  });

  it('rejects identical or case/normalization-equivalent names consistently', () => {
    expect(code(() => normalizeBrands([{ name: 'Acme' }, { name: 'Acme' }]))).toBe('duplicate_brand_id');
    expect(code(() => normalizeBrands([{ name: 'Acme' }, { name: 'ACME' }]))).toBe('duplicate_brand_id');
    expect(code(() => normalizeBrands([{ name: 'Café' }, { name: 'Café'.normalize('NFD') }]))).toBe('duplicate_brand_id');
  });

  it('rejects duplicate client-supplied ids and client ids colliding with a derived id', () => {
    expect(code(() => normalizeBrands([{ brandId: 'x', name: 'A1' }, { brandId: 'x', name: 'B1' }]))).toBe('duplicate_brand_id');
    expect(code(() => normalizeBrands([{ name: 'Acme' }, { brandId: deriveBrandId('Acme'), name: 'Other' }]))).toBe('duplicate_brand_id');
  });

  it('the error message never contains brand names', () => {
    try {
      normalizeBrands([{ name: 'SecretBrand' }, { name: 'SecretBrand' }]);
    } catch (e) {
      expect((e as Error).message).not.toContain('SecretBrand');
    }
  });

  it('explicit distinct ids allow same-name brands', () => {
    const out = normalizeBrands([{ brandId: 'a', name: 'Acme' }, { brandId: 'b', name: 'Acme' }]);
    expect(out.map((b) => b.brandId)).toEqual(['a', 'b']);
  });

  it('enforces workload limits (M6)', () => {
    const L = DEFAULT_BRAND_LIMITS;
    expect(code(() => normalizeBrands(Array.from({ length: L.maxBrands + 1 }, (_, i) => ({ name: `Brand${i}` }))))).toBe('too_many_brands');
    expect(code(() => normalizeBrands([{ name: 'Acme', aliases: ['x'] }]))).toBe('alias_too_short');
    expect(code(() => normalizeBrands([{ name: 'Acme', aliases: [{ value: 'é'.normalize('NFD').slice(0, 1) }] }]))).toBe('alias_too_short');
    expect(code(() => normalizeBrands([{ name: 'Acme', aliases: ['y'.repeat(L.maxAliasLength + 1)] }]))).toBe('alias_too_long');
    expect(code(() => normalizeBrands([{ name: 'Acme', aliases: Array.from({ length: L.maxAliasesPerBrand + 1 }, (_, i) => `al${i}`) }]))).toBe('too_many_aliases');
    // total across brands
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `B${i}x`, aliases: Array.from({ length: 30 }, (_, j) => `a${i}_${j}`) }));
    expect(code(() => normalizeBrands(many))).toBe('too_many_aliases');
    // 2-char alias is fine; duplicate aliases collapse
    const ok = normalizeBrands([{ name: 'Acme', aliases: ['AC', 'AC', { value: 'AC', caseSensitive: true }] }]);
    expect(ok[0]!.aliases).toEqual([{ value: 'AC', caseSensitive: false }, { value: 'AC', caseSensitive: true }]);
  });
});

describe('computeBrandsHash (M5)', () => {
  const a = normalizeBrands([{ name: 'Acme', aliases: ['AC', 'Acme Co'], exclusions: ['acme pie'] }, { name: 'Globex' }]);

  it('is insensitive to brand order, alias order, and Unicode normalization form', () => {
    const b = normalizeBrands([{ name: 'Globex' }, { name: 'Acme', aliases: ['Acme Co', 'AC'], exclusions: ['acme pie'] }]);
    expect(computeBrandsHash(b)).toBe(computeBrandsHash(a));
    const c = normalizeBrands([{ name: 'Café'.normalize('NFD') }]);
    const d = normalizeBrands([{ name: 'Café' }]);
    expect(computeBrandsHash(c)).toBe(computeBrandsHash(d));
  });

  it('changes when any brand content changes', () => {
    const base = computeBrandsHash(a);
    expect(computeBrandsHash(normalizeBrands([{ name: 'Acme', aliases: ['AC'], exclusions: ['acme pie'] }, { name: 'Globex' }]))).not.toBe(base);
    expect(computeBrandsHash(normalizeBrands([{ name: 'Acme', aliases: ['AC', 'Acme Co'] }, { name: 'Globex' }]))).not.toBe(base);
    expect(computeBrandsHash(normalizeBrands([{ name: 'Acme', aliases: ['AC', 'Acme Co'], exclusions: ['acme pie'] }]))).not.toBe(base);
    expect(computeBrandsHash([])).not.toBe(base);
  });
});
