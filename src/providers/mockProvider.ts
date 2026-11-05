import { createHash } from 'node:crypto';
import { ProviderError, type LlmProvider, type ProviderRequest } from './types.js';

/**
 * Deterministic mock LLM. Output depends only on (modelId, prompt without directives).
 *
 * Failure injection via directives embedded in the prompt (dev/test only; OFF unless allowFailureInjection: true,
 * which the app wires from ENABLE_MOCK_FAILURE_INJECTION and never in production):
 *   [[mock:fail=rate_limit;retryAfterMs=200;times=1]]
 *   fail = rate_limit | server_error | timeout | malformed | content_filter | bad_request
 *   times = fail only the first N calls per requestKey (default: always)
 *   hangMs = for timeout: how long to hang (default: until aborted)
 *   mention=Acme|Globex  force extra brand names into the answer
 */
const BRAND_POOL = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Stark Industries', 'Wayne Enterprises', 'Café Zürich'];
const SOURCE_POOL = [
  'https://www.Example.com/reviews/best-tools/?utm_source=ai&utm_medium=chat&b=2&a=1#section',
  'https://docs.acme.test/guide/',
  'https://news.globex.test:443/2026/launch?fbclid=abc123',
  'https://blog.initech.test/compare',
  'https://münchen.example/übersicht',
];
const DIRECTIVE_RE = /\[\[mock:([^\]]*)\]\]/g;

interface Directives {
  fail?: string;
  retryAfterMs?: number;
  times: number;
  hangMs?: number;
  mention: string[];
}

function parseDirectives(prompt: string): { clean: string; d: Directives } {
  const d: Directives = { times: Number.POSITIVE_INFINITY, mention: [] };
  const clean = prompt.replace(DIRECTIVE_RE, (_m, body: string) => {
    for (const kv of body.split(';')) {
      const [k, v = ''] = kv.split('=');
      switch (k?.trim()) {
        case 'fail': d.fail = v.trim(); break;
        case 'retryAfterMs': d.retryAfterMs = Number(v); break;
        case 'times': d.times = Number(v); break;
        case 'hangMs': d.hangMs = Number(v); break;
        case 'mention': d.mention = v.split('|').map((s) => s.trim()).filter(Boolean); break;
      }
    }
    return '';
  });
  return { clean: clean.trim(), d };
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderError('timeout', 'Mock provider timed out'));
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new ProviderError('timeout', 'Mock provider timed out')); };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class MockProvider implements LlmProvider {
  private readonly calls = new Map<string, number>();

  constructor(
    readonly providerId: string,
    private readonly opts: { allowFailureInjection?: boolean } = {},
  ) {}

  /** Number of generate() calls seen for a requestKey (test introspection). */
  callCount(requestKey: string): number {
    return this.calls.get(requestKey) ?? 0;
  }

  async generate(req: ProviderRequest): Promise<unknown> {
    const n = (this.calls.get(req.requestKey) ?? 0) + 1;
    this.calls.set(req.requestKey, n);
    const { clean, d } = parseDirectives(req.prompt);

    if (this.opts.allowFailureInjection === true && d.fail && n <= d.times) {
      switch (d.fail) {
        case 'rate_limit': throw new ProviderError('rate_limited', 'Mock 429', d.retryAfterMs);
        case 'server_error': throw new ProviderError('server_error', 'Mock 503');
        case 'timeout': await sleepAbortable(d.hangMs ?? 3_600_000, req.signal); break;
        case 'content_filter': throw new ProviderError('content_filtered', 'Mock content filter');
        case 'bad_request': throw new ProviderError('bad_request', 'Mock 400');
        case 'malformed': return { text: 42, citations: 'nope' };
      }
    }
    return this.compose(req.modelId, clean, d.mention);
  }

  private compose(modelId: string, prompt: string, forced: string[]) {
    const h = createHash('sha256').update(`${modelId}|${prompt}`).digest();
    const pick = <T>(arr: readonly T[], i: number) => arr[h[i]! % arr.length]!;
    const brands = [...new Set([pick(BRAND_POOL, 0), pick(BRAND_POOL, 1), pick(BRAND_POOL, 2), ...forced])];
    const sources = [...new Set([pick(SOURCE_POOL, 3), pick(SOURCE_POOL, 4), SOURCE_POOL[0]!])];
    const text =
      `According to ${modelId}, the leading options are ${brands.join(', ')}. ` +
      `${brands[0]} is mentioned most often; ${brands[0]} also appears in reviews. ` +
      `See ${sources[0]}. for details, and (${sources[1]}) as well.`;
    return {
      text,
      citations: sources.map((url, i) => ({ url, title: `Source ${i + 1}` })),
      usage: { inputTokens: Math.ceil(prompt.length / 4), outputTokens: Math.ceil(text.length / 4) },
    };
  }
}
