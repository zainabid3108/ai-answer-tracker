import { describe, expect, it } from 'vitest';
import { matchBrands } from '../../src/domain/brandMatcher.js';
import type { Brand } from '../../src/domain/types.js';

const brand = (name: string, extra: Partial<Brand> = {}): Brand => ({
  brandId: name.toLowerCase().replace(/\W+/g, '-'), name, aliases: [], exclusions: [], ...extra,
});

describe('matchBrands', () => {
  it('returns [] when nothing matches or inputs are empty', () => {
    expect(matchBrands('Nothing relevant here', [brand('Acme')])).toEqual([]);
    expect(matchBrands('', [brand('Acme')])).toEqual([]);
    expect(matchBrands('Acme', [])).toEqual([]);
  });

  it('respects word boundaries', () => {
    const b = [brand('Acme')];
    expect(matchBrands('Acmetron and macme and Acme2', b)).toEqual([]);
    expect(matchBrands("(Acme) and Acme's, Acme.", b)[0]?.count).toBe(3);
  });

  it('matches names case-insensitively', () => {
    const m = matchBrands('ACME, acme, Acme', [brand('Acme')]);
    expect(m[0]?.count).toBe(3);
  });

  it('honours case-sensitive aliases only when flagged', () => {
    const ibm = brand('International Business Machines', { aliases: [{ value: 'IBM', caseSensitive: true }] });
    expect(matchBrands('ibm is not IBM-like? no: ibm', [ibm])[0]?.count).toBe(1);
    expect(matchBrands('only ibm here', [ibm])).toEqual([]);
    const loose = brand('Intl', { aliases: [{ value: 'IBM' }] });
    expect(matchBrands('only ibm here', [loose])[0]?.count).toBe(1);
  });

  it('handles unicode names, boundaries and normalization forms', () => {
    const cafe = brand('Café Zürich');
    expect(matchBrands('Try Café Zürich today', [cafe])[0]?.count).toBe(1);
    // decomposed (NFD) input still matches the composed name
    expect(matchBrands('Try Café Zürich today', [cafe])[0]?.count).toBe(1);
    // accented letter continuing a word is not a boundary
    expect(matchBrands('Zoëtrope', [brand('Zoë')])).toEqual([]);
    expect(matchBrands('Zoë!', [brand('Zoë')])[0]?.count).toBe(1);
    expect(matchBrands('我们喜欢 Acme 产品', [brand('Acme')])[0]?.count).toBe(1);
  });

  it('escapes regex metacharacters in names', () => {
    expect(matchBrands('We use C++ daily', [brand('C++')])[0]?.count).toBe(1);
    expect(matchBrands('Dr. Pepper rocks', [brand('Dr. Pepper')])[0]?.count).toBe(1);
  });

  it('resolves overlapping matches by longest span, across brands', () => {
    const brands = [brand('Acme'), brand('Acme Cloud')];
    const only = matchBrands('Acme Cloud rocks', brands);
    expect(only.map((m) => m.name)).toEqual(['Acme Cloud']);
    const both = matchBrands('Acme and Acme Cloud', brands);
    expect(both.map((m) => [m.name, m.count])).toEqual([['Acme', 1], ['Acme Cloud', 1]]);
  });

  it('does not double count overlapping aliases of one brand', () => {
    const b = brand('Acme', { aliases: [{ value: 'Acme Cloud' }, { value: 'Acme' }] });
    expect(matchBrands('Acme Cloud is great', [b])[0]?.count).toBe(1);
  });

  it('applies per-brand exclusions', () => {
    const apple = brand('Apple', { exclusions: ['apple pie'] });
    const m = matchBrands('Apple pie is tasty; Apple phones too.', [apple]);
    expect(m[0]?.count).toBe(1);
    expect(m[0]?.firstPosition).toBe('Apple pie is tasty; '.length);
    expect(matchBrands('only apple pie here', [apple])).toEqual([]);
  });

  it('reports count, firstPosition, rank by first appearance and a snippet', () => {
    const text = 'Globex first. Later Acme, Acme again.';
    const m = matchBrands(text, [brand('Acme'), brand('Globex')]);
    expect(m.map((x) => [x.name, x.rank, x.count, x.firstPosition])).toEqual([
      ['Globex', 1, 1, 0],
      ['Acme', 2, 2, text.indexOf('Acme')],
    ]);
    expect(m[1]?.snippet).toContain('Acme');
  });

  it('is deterministic', () => {
    const t = 'Acme vs Globex vs Acme';
    const b = [brand('Acme'), brand('Globex')];
    expect(matchBrands(t, b)).toEqual(matchBrands(t, b));
  });
});
