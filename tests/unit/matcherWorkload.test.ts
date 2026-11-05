import { describe, expect, it } from 'vitest';
import { analyzeBrands, matchBrands, type MatcherLimits } from '../../src/domain/brandMatcher.js';
import type { Brand, BrandMention } from '../../src/domain/types.js';

const brand = (name: string, extra: Partial<Brand> = {}): Brand => ({ brandId: `id-${name}`, name, aliases: [], exclusions: [], ...extra });

/** Verbatim copy of the pre-M6 O(n^2) algorithm, used as a behavioural oracle. */
function legacyMatch(rawText: string, brands: Brand[]): BrandMention[] {
  const WORD = '[\\p{L}\\p{N}_]';
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const spansOf = (text: string, term: string, cs: boolean) => {
    if (!term) return [];
    const out: Array<{ start: number; end: number }> = [];
    for (const m of text.matchAll(new RegExp(`(?<!${WORD})${esc(term)}(?!${WORD})`, cs ? 'gu' : 'giu'))) out.push({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length });
    return out;
  };
  const text = rawText.normalize('NFC');
  const cands: Array<{ start: number; end: number; brandIndex: number }> = [];
  brands.forEach((b, brandIndex) => {
    const terms = [{ value: b.name, caseSensitive: false }, ...b.aliases];
    const ex = b.exclusions.flatMap((x) => spansOf(text, x.normalize('NFC').trim(), false));
    for (const t of terms) for (const sp of spansOf(text, t.value.normalize('NFC').trim(), t.caseSensitive ?? false)) {
      if (ex.some((e) => e.start <= sp.start && sp.end <= e.end)) continue;
      cands.push({ ...sp, brandIndex });
    }
  });
  cands.sort((a, b) => b.end - b.start - (a.end - a.start) || a.brandIndex - b.brandIndex || a.start - b.start);
  const acc: typeof cands = [];
  for (const c of cands) if (!acc.some((a) => a.start < c.end && c.start < a.end)) acc.push(c);
  const by = new Map<number, typeof cands>();
  for (const c of acc) by.set(c.brandIndex, [...(by.get(c.brandIndex) ?? []), c]);
  const ms = [...by.entries()].map(([i, l]) => {
    l.sort((a, b) => a.start - b.start);
    return { brandId: brands[i]!.brandId, name: brands[i]!.name, count: l.length, firstPosition: l[0]!.start };
  });
  ms.sort((a, b) => a.firstPosition - b.firstPosition);
  return ms.map((m, i) => ({ ...m, rank: i + 1, snippet: '' }));
}

/** Small deterministic PRNG so the randomized comparison is reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

describe('matcher: behaviour preserved vs the previous algorithm', () => {
  it('matches the legacy implementation on randomized overlapping inputs', () => {
    const r = rng(42);
    const words = ['acme', 'cloud', 'acme cloud', 'globex', 'initech', 'pie', 'apple', 'apple pie', 'x1', 'zz', 'foo', 'Café', 'ACME'];
    const pick = <T>(a: T[]) => a[Math.floor(r() * a.length)]!;
    for (let round = 0; round < 60; round++) {
      const text = Array.from({ length: 30 + Math.floor(r() * 40) }, () => pick(words)).join(r() > 0.2 ? ' ' : ', ');
      const brands = [
        brand('Acme', { aliases: [{ value: 'acme cloud' }, { value: 'AC', caseSensitive: true }] }),
        brand('Acme Cloud'),
        brand('Apple', { exclusions: ['apple pie'] }),
        brand('Globex', { aliases: [{ value: 'foo' }] }),
        brand('Café'),
      ];
      const got = matchBrands(text, brands).map(({ snippet: _s, ...m }) => m);
      const want = legacyMatch(text, brands).map(({ snippet: _s, ...m }) => m);
      expect(got).toEqual(want);
    }
  });
});

describe('matcher: workload bounds (M6)', () => {
  it('worst-case input (max brands/aliases, long answer, every term matching everywhere) completes within a generous bound', () => {
    // 100 brands, 5 aliases each (=500 aliases), answer of 100k chars made only of matching tokens.
    const brands = Array.from({ length: 100 }, (_, i) =>
      brand(`aa${i}`, { aliases: Array.from({ length: 5 }, (_, j) => ({ value: `aa${i}`.repeat(1) + `b${j}` })), exclusions: ['aa1 aa1'] }),
    );
    const text = Array.from({ length: 30_000 }, (_, i) => `aa${i % 100}`).join(' ').slice(0, 150_000);
    const t0 = performance.now();
    const res = analyzeBrands(text, brands);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(15_000); // generous CI bound; typically well under a few seconds
    expect(res.truncated).toBe(true); // text > maxTextLength and/or caps hit
    expect(res.mentions.length).toBeGreaterThan(0);
  });

  it('a single-term flood is capped per term and flagged', () => {
    const limits: MatcherLimits = { maxTextLength: 100_000, maxMatchesPerTerm: 50, maxCandidates: 10_000 };
    const res = analyzeBrands('acme '.repeat(5_000), [brand('Acme')], limits);
    expect(res.truncated).toBe(true);
    expect(res.mentions[0]!.count).toBe(50);
  });

  it('overall candidate cap stops collection and flags truncation', () => {
    const limits: MatcherLimits = { maxTextLength: 100_000, maxMatchesPerTerm: 1_000, maxCandidates: 120 };
    const brands = Array.from({ length: 10 }, (_, i) => brand(`tok${i}`));
    const text = Array.from({ length: 10 }, (_, i) => `tok${i} `.repeat(100)).join('');
    const res = analyzeBrands(text, brands, limits);
    expect(res.truncated).toBe(true);
    expect(res.mentions.reduce((n, m) => n + m.count, 0)).toBeLessThanOrEqual(120);
  });

  it('analyzes only the capped prefix of a very long answer and flags it', () => {
    const limits: MatcherLimits = { maxTextLength: 1_000, maxMatchesPerTerm: 1_000, maxCandidates: 10_000 };
    const text = `${'filler '.repeat(200)}Acme`; // Acme sits beyond the cap
    const res = analyzeBrands(text, [brand('Acme')], limits);
    expect(res.truncated).toBe(true);
    expect(res.mentions).toEqual([]);
  });

  it('normal inputs are not flagged as truncated', () => {
    expect(analyzeBrands('Acme and Globex', [brand('Acme'), brand('Globex')]).truncated).toBe(false);
  });
});
