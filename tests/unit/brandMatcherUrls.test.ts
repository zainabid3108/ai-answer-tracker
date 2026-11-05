import { describe, expect, it } from 'vitest';
import { analyzeBrands, matchBrands, maskUrls, type MatcherLimits } from '../../src/domain/brandMatcher.js';
import { extractUrlsFromText, findUrlSpans, normalizeCitations, trimTrailingPunctuation } from '../../src/domain/citations.js';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { parseProviderResponse } from '../../src/providers/types.js';
import type { Brand } from '../../src/domain/types.js';

const brand = (name: string, extra: Partial<Brand> = {}): Brand => ({ brandId: `id-${name}`, name, aliases: [], exclusions: [], ...extra });
const G = [brand('Globex')];

/**
 * Decisions under test (see docs/decisions.md "answer-text mentions"):
 * - http(s) URLs and bare `www.` links are masked; markdown link TEXT stays matchable, the target does not.
 * - A bare domain-like token such as `Globex.com` (no scheme, no www.) is NOT a URL and stays matchable as text.
 */
describe('brand matching ignores URLs (answer-text mentions only)', () => {
  it.each([
    ['http', 'See http://globex.test/a for more'],
    ['https', 'See https://globex.test/a for more'],
    ['port', 'See https://news.globex.test:443/2026/launch?x=1 for more'],
    ['query', 'See https://x.test/p?vendor=Globex&q=globex for more'],
    ['fragment', 'See https://x.test/p#Globex for more'],
    ['userinfo', 'See https://Globex:secret@x.test/ for more'],
    ['trailing period', 'Read https://globex.test/a.'],
    ['trailing comma/paren', 'Read (https://globex.test/a), then more'],
    ['trailing punctuation mix', 'Read https://globex.test/a?!;:'],
    ['angle autolink', 'Read <https://globex.test/a> now'],
    ['quoted', 'Read "https://globex.test/a" now'],
    ['bare www', 'Read www.globex.test/a now'],
    ['markdown target only', 'Read [the docs](https://globex.test/docs) now'],
    ['uppercase scheme', 'Read HTTPS://GLOBEX.TEST/A now'],
    ['URL only', 'https://globex.test'],
  ])('URL-only occurrence (%s) yields no mention', (_n, text) => {
    expect(matchBrands(text, G)).toEqual([]);
  });

  it('counts only visible-text occurrences and keeps original offsets and snippets', () => {
    const text = 'Globex is big. See https://globex.test/globex today. Globex again, https://news.globex.test:443/x?fbclid=1.';
    const [m] = matchBrands(text, G);
    expect(m!.count).toBe(2);
    expect(m!.firstPosition).toBe(0);

    const t2 = 'Prefix words https://globex.test/a and then Globex arrives.';
    const [m2] = matchBrands(t2, G);
    expect(m2!.count).toBe(1);
    expect(m2!.firstPosition).toBe(t2.indexOf('Globex arrives'));
    expect(t2.slice(m2!.firstPosition, m2!.firstPosition + 6)).toBe('Globex');
    // snippet comes from the ORIGINAL text, so the URL is shown intact and no mask char leaks
    expect(m2!.snippet).toContain('https://globex.test/a');
    expect(m2!.snippet).not.toContain('\u0000');
  });

  it('legitimate mentions adjacent to URLs still match', () => {
    for (const text of [
      'Globex (https://x.test) rocks',
      'See Globex: https://x.test/a',
      'https://x.test Globex',
      'https://x.test/a, Globex.',
      'Globex<https://x.test/a>',
      '(Globex)https://x.test/a',
    ]) {
      const m = matchBrands(text, G);
      expect(m, text).toHaveLength(1);
      expect(m[0]!.count, text).toBe(1);
      expect(text.slice(m[0]!.firstPosition, m[0]!.firstPosition + 6), text).toBe('Globex');
    }
  });

  it('markdown: brand in link text matches, same brand in target does not', () => {
    const text = 'Try [Globex](https://globex.test/globex) now';
    const [m] = matchBrands(text, G);
    expect(m!.count).toBe(1);
    expect(m!.firstPosition).toBe(text.indexOf('Globex'));
    // balanced parentheses in the target are part of the URL
    expect(matchBrands('[docs](https://en.wikipedia.org/wiki/Globex_(company)) end', G)).toEqual([]);
  });

  it('bare domain-like tokens without scheme/www stay matchable as text (documented decision)', () => {
    expect(matchBrands('Visit Globex.com today', G)[0]!.count).toBe(1);
    expect(matchBrands('Visit globex.com/pricing today', G)[0]!.count).toBe(1);
    expect(findUrlSpans('Visit Globex.com today', { includeBareWww: true })).toEqual([]);
    // but www. links are masked
    expect(matchBrands('Visit www.globex.com today', G)).toEqual([]);
    // 'www.' inside an email address is not a www link
    expect(matchBrands('mail x@www.globex.com', G)[0]?.count ?? 0).toBe(1);
  });

  it('masking does not fuse words across the masked region', () => {
    const b = [brand('foobar'), brand('Acme Cloud'), brand('Globex')];
    expect(matchBrands('foohttps://x.test/abar', b)).toEqual([]);
    expect(matchBrands('foo https://x.test/a bar', b)).toEqual([]);
    expect(matchBrands('Acme https://x.test/a Cloud', b)).toEqual([]);
    // brand glued to the start of a URL: boundary after the brand holds
    expect(matchBrands('Globexhttps://x.test/a', b)[0]?.name).toBe('Globex');
    // word chars glued after a URL tail are part of the URL (no whitespace), never a brand
    expect(matchBrands('https://x.test/a Globexx', b)).toEqual([]);
  });

  it('case-sensitive alias inside a URL is ignored; same alias in prose matches', () => {
    const b = [brand('Zed', { aliases: [{ value: 'GLX', caseSensitive: true }] })];
    expect(matchBrands('see https://x.test/GLX/page', b)).toEqual([]);
    expect(matchBrands('see https://x.test/GLX/page and GLX here', b)[0]!.count).toBe(1);
    expect(matchBrands('see glx here', b)).toEqual([]);
  });

  it('multiple URLs and multiple brands: ranks follow visible text only', () => {
    const text = 'Initech https://globex.test/a Acme https://acme.test https://initech.test/x Globex';
    const m = matchBrands(text, [brand('Acme'), brand('Globex'), brand('Initech')]);
    expect(m.map((x) => [x.name, x.rank, x.count, x.firstPosition])).toEqual([
      ['Initech', 1, 1, 0],
      ['Acme', 2, 1, text.indexOf('Acme')],
      ['Globex', 3, 1, text.lastIndexOf('Globex')],
    ]);
  });

  it('Unicode: IDN hosts, percent-encoded and raw Unicode paths', () => {
    const uni = [brand('München'), brand('Übersicht'), brand('Москва'), brand('東京')];
    expect(matchBrands('Siehe https://münchen.example/übersicht für mehr', uni)).toEqual([]);
    expect(matchBrands('Siehe https://xn--mnchen-3ya.example/%C3%9Cbersicht', uni)).toEqual([]);
    expect(matchBrands('Ссылка https://москва.example/Москва/путь и https://例え.jp/東京/ok', uni)).toEqual([]);

    const text = 'Москва и 東京 в тексте; https://москва.example/Москва/путь, а München тоже. https://東京.example/東京';
    const m = matchBrands(text, uni);
    expect(m.map((x) => [x.name, x.count])).toEqual([['Москва', 1], ['東京', 1], ['München', 1]]);
    for (const x of m) expect(text.slice(x.firstPosition, x.firstPosition + x.name.length)).toBe(x.name);
    // NFD input is normalized; offsets refer to the NFC text (documented)
    const nfd = 'Siehe https://münchen.example/x und München'.normalize('NFD');
    const [mm] = matchBrands(nfd, uni);
    const nfc = nfd.normalize('NFC');
    expect(mm!.count).toBe(1);
    expect(nfc.slice(mm!.firstPosition, mm!.firstPosition + 7)).toBe('München');
  });

  it('empty and very long URL strings', () => {
    expect(matchBrands('https:// Globex', G)[0]!.count).toBe(1); // scheme alone is not a URL
    expect(matchBrands('', G)).toEqual([]);
    const long = `https://x.test/${'a/Globex'.repeat(10_000)}`;
    expect(matchBrands(`${long} end`, G)).toEqual([]);
    expect(matchBrands(`Globex ${long} Globex`, G)[0]!.count).toBe(2);
  });

  it('hostile trailing punctuation is linear time', () => {
    const t = `https://x.test/${')'.repeat(90_000)}`;
    const t0 = performance.now();
    expect(trimTrailingPunctuation(t)).toBe('https://x.test/');
    matchBrands(t, G);
    expect(performance.now() - t0).toBeLessThan(2_000);
  });

  it('the original text is not modified by analysis', () => {
    const text = 'Globex https://globex.test/a';
    const copy = String(text);
    analyzeBrands(text, G);
    expect(text).toBe(copy);
  });

  it('exclusions are evaluated on the masked text too', () => {
    const b = [brand('Apple', { exclusions: ['apple pie'] })];
    expect(matchBrands('apple pie https://apple.test', b)).toEqual([]);
    expect(matchBrands('apple https://pie.test', b)[0]!.count).toBe(1);
  });
});

describe('shared URL-span definition (citations.ts)', () => {
  it('extractUrlsFromText output equals the spans (single source of truth) and ignores bare www', () => {
    const t = 'See https://a.com/x. Also (https://b.com/y) and "https://c.com/z", www.d.com/q done! [t](https://e.com/p_(1)).';
    const spans = findUrlSpans(t);
    expect(spans.map((s) => t.slice(s.start, s.end))).toEqual(extractUrlsFromText(t));
    expect(extractUrlsFromText(t)).toEqual(['https://a.com/x', 'https://b.com/y', 'https://c.com/z', 'https://e.com/p_(1)']);
    expect(findUrlSpans(t, { includeBareWww: true }).map((s) => t.slice(s.start, s.end))).toContain('www.d.com/q');
  });

  it('maskUrls preserves length and replaces only URL characters', () => {
    const t = 'a https://x.test/a, b www.y.test. c';
    const masked = maskUrls(t);
    expect(masked).toHaveLength(t.length);
    expect(masked.replace(/\u0000/g, '')).toBe('a , b . c');
  });
});

describe('workload limits still hold with masking', () => {
  it('worst case with many URLs stays bounded and flagged', () => {
    const brands = Array.from({ length: 100 }, (_, i) => brand(`aa${i}`, { aliases: [{ value: `aa${i}b1` }] }));
    const text = Array.from({ length: 20_000 }, (_, i) => `aa${i % 100} https://aa${i % 100}.test/p`).join(' ');
    const t0 = performance.now();
    const res = analyzeBrands(text, brands);
    expect(performance.now() - t0).toBeLessThan(15_000);
    expect(res.truncated).toBe(true);
    expect(res.mentions.length).toBe(100);
  });

  it('caps and truncated flag unchanged; URL-only floods yield nothing and are not flagged', () => {
    const limits: MatcherLimits = { maxTextLength: 100_000, maxMatchesPerTerm: 50, maxCandidates: 10_000 };
    const flood = analyzeBrands('https://acme.test/ '.repeat(5_000), [brand('Acme')], limits);
    expect(flood.mentions).toEqual([]);
    expect(flood.truncated).toBe(false);
    const prose = analyzeBrands('acme https://acme.test '.repeat(5_000), [brand('Acme')], limits);
    expect(prose.truncated).toBe(true);
    expect(prose.mentions[0]!.count).toBe(50);
  });

  it('randomized: results equal matching over the text with URLs replaced by spaces', () => {
    let s = 7;
    const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pieces = ['acme', 'globex', 'Café', 'acme cloud', 'https://globex.test/acme', '(https://acme.test/x)', 'www.cafe.test', 'foo'];
    const brands = [brand('Acme', { aliases: [{ value: 'acme cloud' }] }), brand('Globex'), brand('Café')];
    const strip = (ms: ReturnType<typeof matchBrands>) => ms.map(({ snippet: _s, ...m }) => m);
    for (let round = 0; round < 60; round++) {
      const text = Array.from({ length: 40 }, () => pieces[Math.floor(r() * pieces.length)]!).join(' ');
      const spaced = text.replace(/(?:https?:\/\/|www\.)[^\s<>"'`]+/gi, (u) => ' '.repeat(u.length));
      expect(spaced).toHaveLength(text.length);
      expect(strip(matchBrands(text, brands))).toEqual(strip(matchBrands(spaced, brands)));
    }
  });
});

describe('pipeline-style: mock provider answer -> mentions vs citations', () => {
  it('URL-only brands produce no mentions while citations still contain their URLs/domains', async () => {
    const provider = new MockProvider('mock');
    const brands = [brand('Globex'), brand('Initech'), brand('Acme'), brand('Hooli'), brand('Umbrella')];
    let urlOnlyCases = 0;
    for (let i = 0; i < 60; i++) {
      const resp = parseProviderResponse(
        await provider.generate({ prompt: `question ${i}`, modelId: 'm', requestKey: `k${i}`, signal: new AbortController().signal }),
      );
      const text = resp.text.normalize('NFC');
      const { mentions } = analyzeBrands(text, brands);
      const citations = normalizeCitations(resp.citations, text);
      // Expected visible-prose counts computed independently by blanking every URL first.
      const prose = text.replace(/https?:\/\/[^\s<>"'`]+/gi, (u) => ' '.repeat(u.length));
      for (const b of brands) {
        const expected = (prose.match(new RegExp(`(?<![\\p{L}\\p{N}_])${b.name}(?![\\p{L}\\p{N}_])`, 'giu')) ?? []).length;
        expect(mentions.find((m) => m.name === b.name)?.count ?? 0, `${i}:${b.name}`).toBe(expected);
      }
      for (const m of mentions) expect(text.slice(m.firstPosition, m.firstPosition + m.name.length)).toBe(m.name);
      for (const [name, domainPart] of [['Globex', 'globex.test'], ['Initech', 'initech.test']] as const) {
        if (citations.some((c) => c.domain.endsWith(domainPart)) && !mentions.some((m) => m.name === name)) urlOnlyCases++;
      }
      // citations are untouched by masking: every provider URL is still present
      for (const c of resp.citations) expect(citations.some((x) => x.rawUrl === c.url)).toBe(true);
    }
    expect(urlOnlyCases).toBeGreaterThan(0);
  });
});
