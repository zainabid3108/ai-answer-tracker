import type { Citation, RawCitation } from './types.js';

const TRACKING_PARAMS = new Set([
  'gclid', 'fbclid', 'msclkid', 'dclid', 'yclid', 'igshid', 'mc_cid', 'mc_eid', '_ga', '_gl', 'ref_src', 'mkt_tok', 'srsltid',
]);

function isTracking(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith('utm_') || TRACKING_PARAMS.has(n);
}

const CLOSERS: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
const TRAILING_PUNCT = `.,;:!?'"*`;

/**
 * Strip punctuation that commonly trails a URL in prose. Closing brackets only if unbalanced.
 * Linear time (bracket counts are maintained incrementally) so very long hostile URLs cannot cause quadratic work.
 */
export function trimTrailingPunctuation(url: string): string {
  const count: Record<string, number> = { '(': 0, ')': 0, '[': 0, ']': 0, '{': 0, '}': 0 };
  for (let i = 0; i < url.length; i++) {
    const c = url[i]!;
    if (c in count) count[c]!++;
  }
  let end = url.length;
  while (end > 0) {
    const last = url[end - 1]!;
    if (TRAILING_PUNCT.includes(last)) {
      end--;
      continue;
    }
    const open = CLOSERS[last];
    if (open && count[last]! > count[open]!) {
      count[last]!--;
      end--;
      continue;
    }
    break;
  }
  return url.slice(0, end);
}

export interface NormalizedUrl {
  normalizedUrl: string;
  domain: string;
}

/**
 * Normalize an http(s) URL: lowercase/punycode host (via WHATWG URL), drop default port, fragment,
 * credentials, tracking params and trailing slash (non-root); sort remaining params.
 * domain = host without leading "www." (no public-suffix list in M1).
 * Returns null for unparsable or non-http(s) input.
 */
export function normalizeUrl(raw: string): NormalizedUrl | null {
  let u: URL;
  try {
    u = new URL(trimTrailingPunctuation(raw.trim()));
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  const kept: Array<[string, string]> = [];
  for (const [k, v] of u.searchParams) if (!isTracking(k)) kept.push([k, v]);
  kept.sort((a, b) => (a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0])));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '') || '/';
  const domain = u.hostname.replace(/^www\./, '');
  let normalizedUrl = u.toString();
  if (u.pathname === '/' && !u.search) normalizedUrl = normalizedUrl.replace(/\/$/, '');
  return { normalizedUrl, domain };
}

const URL_TAIL = String.raw`[^\s<>"'` + '`' + String.raw`]+`;
const URL_IN_TEXT = new RegExp(String.raw`https?://` + URL_TAIL, 'gi');
/** Superset used for masking: also bare `www.` links (not preceded by a word char, '.', '@', '/' or '-'). */
const URL_OR_WWW_IN_TEXT = new RegExp(String.raw`(?:https?://|(?<![\p{L}\p{N}_.@/-])www\.)` + URL_TAIL, 'giu');

export interface UrlSpan {
  start: number;
  /** Exclusive end, after trailing-punctuation trimming. */
  end: number;
}

/**
 * Single source of truth for "what is a URL in free text": returns the [start,end) spans of URLs in `text`
 * with trailing prose punctuation already trimmed. Default = http(s) only (what citations extract).
 * `includeBareWww` additionally reports scheme-less `www.` links; used for brand masking, never for citations.
 */
export function findUrlSpans(text: string, opts: { includeBareWww?: boolean } = {}): UrlSpan[] {
  const re = opts.includeBareWww ? URL_OR_WWW_IN_TEXT : URL_IN_TEXT;
  const spans: UrlSpan[] = [];
  for (const m of text.matchAll(re)) {
    const trimmed = trimTrailingPunctuation(m[0]);
    if (/^www\.$/i.test(trimmed) || trimmed.length === 0) continue;
    spans.push({ start: m.index ?? 0, end: (m.index ?? 0) + trimmed.length });
  }
  return spans;
}

/** Extract http(s) URLs from free text, trimming trailing prose punctuation. */
export function extractUrlsFromText(text: string): string[] {
  return findUrlSpans(text).map((sp) => text.slice(sp.start, sp.end));
}

/**
 * Merge provider-supplied citations with URLs found in text, normalize, and dedupe by normalizedUrl
 * (first occurrence wins; provider citations first so titles are kept). Positions are 0-based.
 */
export function normalizeCitations(provided: RawCitation[], answerText: string): Citation[] {
  const candidates: RawCitation[] = [...provided, ...extractUrlsFromText(answerText).map((url) => ({ url }))];
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of candidates) {
    const n = normalizeUrl(c.url);
    if (!n || seen.has(n.normalizedUrl)) continue;
    seen.add(n.normalizedUrl);
    const cit: Citation = { position: out.length, rawUrl: c.url, normalizedUrl: n.normalizedUrl, domain: n.domain };
    if (c.title) cit.title = c.title;
    out.push(cit);
  }
  return out;
}
