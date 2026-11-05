import { createHash } from 'node:crypto';
import type { Brand } from './types.js';

/** Pure brand validation / normalization / identity helpers (no framework imports). */

export interface BrandInput {
  brandId?: string;
  name: string;
  aliases?: Array<string | { value: string; caseSensitive?: boolean }>;
  exclusions?: string[];
}

export interface BrandLimits {
  maxBrands: number;
  maxAliasesPerBrand: number;
  /** Across all brands of one request/tenant snapshot. */
  maxTotalAliases: number;
  minAliasLength: number;
  maxAliasLength: number;
  maxNameLength: number;
  maxExclusionsPerBrand: number;
  maxTotalExclusions: number;
}

export const DEFAULT_BRAND_LIMITS: BrandLimits = {
  maxBrands: 100,
  maxAliasesPerBrand: 50,
  maxTotalAliases: 500,
  minAliasLength: 2,
  maxAliasLength: 100,
  maxNameLength: 200,
  maxExclusionsPerBrand: 50,
  maxTotalExclusions: 500,
};

/** Validation failure with a stable machine-readable code. Messages never contain brand text. */
export class BrandValidationError extends Error {
  constructor(
    readonly code: 'too_many_brands' | 'too_many_aliases' | 'too_many_exclusions' | 'alias_too_short' | 'alias_too_long' | 'invalid_brand' | 'duplicate_brand_id',
    message: string,
  ) {
    super(message);
    this.name = 'BrandValidationError';
  }
}

const nfc = (s: string) => s.normalize('NFC').trim();

/**
 * Stable, Unicode-safe fallback id: `b_` + sha256 prefix of the NFC-normalized, whitespace-collapsed,
 * case-folded name. Never a lossy ASCII slug, so "Café" / "Cafe" / "Кафе" / "咖啡" are all distinct,
 * while "Café" in NFC vs NFD (and "CAFÉ") map to the same id.
 */
export function deriveBrandId(name: string): string {
  const folded = nfc(name).replace(/\s+/g, ' ').toLowerCase().normalize('NFC');
  return `b_${createHash('sha256').update(folded).digest('hex').slice(0, 24)}`;
}

/**
 * Validate and normalize client/tenant brand input into canonical Brand objects (input order preserved).
 * Rejects duplicate brandIds (client supplied or derived) - identical names therefore collide consistently.
 */
export function normalizeBrands(inputs: BrandInput[], limits: BrandLimits = DEFAULT_BRAND_LIMITS): Brand[] {
  if (inputs.length > limits.maxBrands) throw new BrandValidationError('too_many_brands', `At most ${limits.maxBrands} brands are allowed`);

  const seen = new Map<string, number>();
  let totalAliases = 0;
  let totalExclusions = 0;
  const out: Brand[] = [];

  inputs.forEach((b, i) => {
    const name = nfc(b.name);
    if (!name || name.length > limits.maxNameLength) throw new BrandValidationError('invalid_brand', `brands[${i}].name must be 1-${limits.maxNameLength} characters`);

    const aliases: Brand['aliases'] = [];
    const aliasSeen = new Set<string>();
    for (const a of b.aliases ?? []) {
      const value = nfc(typeof a === 'string' ? a : a.value);
      const caseSensitive = typeof a === 'string' ? false : (a.caseSensitive ?? false);
      if (value.length < limits.minAliasLength) throw new BrandValidationError('alias_too_short', `brands[${i}] has an alias shorter than ${limits.minAliasLength} characters`);
      if (value.length > limits.maxAliasLength) throw new BrandValidationError('alias_too_long', `brands[${i}] has an alias longer than ${limits.maxAliasLength} characters`);
      const k = `${caseSensitive ? 1 : 0}|${value}`;
      if (aliasSeen.has(k)) continue;
      aliasSeen.add(k);
      aliases.push({ value, caseSensitive });
    }
    if (aliases.length > limits.maxAliasesPerBrand) throw new BrandValidationError('too_many_aliases', `brands[${i}] has more than ${limits.maxAliasesPerBrand} aliases`);
    totalAliases += aliases.length;
    if (totalAliases > limits.maxTotalAliases) throw new BrandValidationError('too_many_aliases', `At most ${limits.maxTotalAliases} aliases are allowed across all brands`);

    const exclusions = [...new Set((b.exclusions ?? []).map(nfc))];
    if (exclusions.some((x) => x.length < 1 || x.length > limits.maxAliasLength)) throw new BrandValidationError('invalid_brand', `brands[${i}] has an invalid exclusion phrase`);
    if (exclusions.length > limits.maxExclusionsPerBrand) throw new BrandValidationError('too_many_exclusions', `brands[${i}] has more than ${limits.maxExclusionsPerBrand} exclusions`);
    totalExclusions += exclusions.length;
    if (totalExclusions > limits.maxTotalExclusions) throw new BrandValidationError('too_many_exclusions', `At most ${limits.maxTotalExclusions} exclusions are allowed across all brands`);

    const brandId = b.brandId ?? deriveBrandId(name);
    const prev = seen.get(brandId);
    if (prev !== undefined) {
      throw new BrandValidationError('duplicate_brand_id', `brands[${i}] and brands[${prev}] resolve to the same brandId; give distinct names or explicit distinct brandIds`);
    }
    seen.set(brandId, i);
    out.push({ brandId, name, aliases, exclusions });
  });
  return out;
}

/**
 * Order-insensitive, normalization-insensitive fingerprint of a brand set. Works on already-normalized
 * brands and on rows loaded from storage (it re-canonicalizes defensively).
 */
export function computeBrandsHash(brands: Brand[]): string {
  const canon = brands
    .map((b) => ({
      id: b.brandId,
      n: nfc(b.name),
      a: [...new Set(b.aliases.map((a) => `${a.caseSensitive ? 1 : 0}${nfc(a.value)}`))].sort(),
      x: [...new Set(b.exclusions.map(nfc))].sort(),
    }))
    .sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(canon)).digest('hex');
}
