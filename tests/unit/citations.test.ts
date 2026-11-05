import { describe, expect, it } from 'vitest';
import { extractUrlsFromText, normalizeCitations, normalizeUrl, trimTrailingPunctuation } from '../../src/domain/citations.js';

describe('normalizeUrl', () => {
  it('strips tracking params, keeps and sorts the rest, drops fragment', () => {
    const n = normalizeUrl('https://Example.com/a/?utm_source=x&b=2&gclid=zz&a=1&UTM_Campaign=c#frag');
    expect(n).toEqual({ normalizedUrl: 'https://example.com/a?a=1&b=2', domain: 'example.com' });
  });

  it('removes default ports but keeps custom ones', () => {
    expect(normalizeUrl('https://example.com:443/x')?.normalizedUrl).toBe('https://example.com/x');
    expect(normalizeUrl('http://example.com:80/x')?.normalizedUrl).toBe('http://example.com/x');
    expect(normalizeUrl('https://example.com:8443/x')?.normalizedUrl).toBe('https://example.com:8443/x');
  });

  it('normalizes root and trailing slashes', () => {
    expect(normalizeUrl('https://example.com/')?.normalizedUrl).toBe('https://example.com');
    expect(normalizeUrl('https://example.com')?.normalizedUrl).toBe('https://example.com');
    expect(normalizeUrl('https://example.com/a/b///')?.normalizedUrl).toBe('https://example.com/a/b');
    expect(normalizeUrl('https://example.com/?utm_source=x')?.normalizedUrl).toBe('https://example.com');
  });

  it('strips www only from domain and credentials from url', () => {
    const n = normalizeUrl('https://user:pw@www.Example.com/x');
    expect(n?.domain).toBe('example.com');
    expect(n?.normalizedUrl).toBe('https://www.example.com/x');
  });

  it('converts IDN hosts to punycode', () => {
    const n = normalizeUrl('https://münchen.example/übersicht');
    expect(n?.domain).toBe('xn--mnchen-3ya.example');
    expect(n?.normalizedUrl).toBe('https://xn--mnchen-3ya.example/%C3%BCbersicht');
  });

  it('trims trailing prose punctuation', () => {
    expect(normalizeUrl('https://example.com/x).')?.normalizedUrl).toBe('https://example.com/x');
    expect(normalizeUrl('https://example.com/x,')?.normalizedUrl).toBe('https://example.com/x');
  });

  it('rejects non-http(s) and garbage', () => {
    expect(normalizeUrl('ftp://example.com/x')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });
});

describe('trimTrailingPunctuation / extractUrlsFromText', () => {
  it('keeps balanced parentheses (wikipedia style) but drops unbalanced ones', () => {
    expect(trimTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(bar)')).toBe('https://en.wikipedia.org/wiki/Foo_(bar)');
    expect(trimTrailingPunctuation('https://example.com/x)')).toBe('https://example.com/x');
    expect(trimTrailingPunctuation('https://example.com/x).')).toBe('https://example.com/x');
  });

  it('extracts urls from prose', () => {
    const t = 'See https://a.com/x. Also (https://b.com/y) and "https://c.com/z", done!';
    expect(extractUrlsFromText(t)).toEqual(['https://a.com/x', 'https://b.com/y', 'https://c.com/z']);
  });
});

describe('normalizeCitations', () => {
  it('dedupes across provider list and text, preserving first rawUrl, title and order', () => {
    const out = normalizeCitations(
      [
        { url: 'https://www.example.com/a/?utm_source=x#top', title: 'A' },
        { url: 'https://other.com/b' },
      ],
      'Read https://www.example.com/a. and https://third.com/c, also https://other.com/b/.',
    );
    expect(out.map((c) => c.normalizedUrl)).toEqual(['https://www.example.com/a', 'https://other.com/b', 'https://third.com/c']);
    expect(out[0]).toMatchObject({ position: 0, rawUrl: 'https://www.example.com/a/?utm_source=x#top', domain: 'example.com', title: 'A' });
    expect(out.map((c) => c.position)).toEqual([0, 1, 2]);
  });

  it('skips unparsable provider urls', () => {
    expect(normalizeCitations([{ url: 'nope' }], 'no links')).toEqual([]);
  });
});
