import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/providers/mockProvider.js';
import { ProviderError, parseProviderResponse, type ProviderRequest } from '../../src/providers/types.js';
import { createProviderRegistry } from '../../src/providers/registry.js';

const req = (prompt: string, over: Partial<ProviderRequest> = {}): ProviderRequest => ({
  prompt, modelId: 'm1', requestKey: 'k1', signal: new AbortController().signal, ...over,
});

describe('MockProvider', () => {
  it('is deterministic for the same model and prompt, and varies by model/prompt', async () => {
    const p = new MockProvider('mock', { allowFailureInjection: true });
    const a = await p.generate(req('best crm tools'));
    const b = await p.generate(req('best crm tools', { requestKey: 'other' }));
    expect(a).toEqual(b);
    expect(await p.generate(req('best crm tools', { modelId: 'm2' }))).not.toEqual(a);
    expect(await p.generate(req('different question'))).not.toEqual(a);
  });

  it('emits schema-valid output containing brands and citations', async () => {
    const out = parseProviderResponse(await new MockProvider('mock', { allowFailureInjection: true }).generate(req('q [[mock:mention=Acme|Globex]]')));
    expect(out.text).toContain('Acme');
    expect(out.text).toContain('Globex');
    expect(out.citations.length).toBeGreaterThan(0);
    expect(out.usage.outputTokens).toBeGreaterThan(0);
  });

  it('ignores directives for determinism (same output with or without a non-failing directive)', async () => {
    const p = new MockProvider('mock', { allowFailureInjection: true });
    expect(await p.generate(req('q [[mock:latencyMs=1]]'))).toEqual(await p.generate(req('q')));
  });

  it('injects 429 with Retry-After, retryable', async () => {
    const e = await new MockProvider('mock', { allowFailureInjection: true }).generate(req('q [[mock:fail=rate_limit;retryAfterMs=1500]]')).catch((x) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'rate_limited', retryAfterMs: 1500, retryable: true });
  });

  it('injects 5xx as retryable, content filter and bad request as non-retryable', async () => {
    const p = new MockProvider('mock', { allowFailureInjection: true });
    expect(await p.generate(req('q [[mock:fail=server_error]]')).catch((x) => x)).toMatchObject({ kind: 'server_error', retryable: true });
    expect(await p.generate(req('q [[mock:fail=content_filter]]')).catch((x) => x)).toMatchObject({ kind: 'content_filtered', retryable: false });
    expect(await p.generate(req('q [[mock:fail=bad_request]]')).catch((x) => x)).toMatchObject({ kind: 'bad_request', retryable: false });
  });

  it('fails only the first N calls per requestKey when times is set', async () => {
    const p = new MockProvider('mock', { allowFailureInjection: true });
    const prompt = 'q [[mock:fail=server_error;times=2]]';
    await expect(p.generate(req(prompt))).rejects.toBeInstanceOf(ProviderError);
    await expect(p.generate(req(prompt))).rejects.toBeInstanceOf(ProviderError);
    await expect(p.generate(req(prompt))).resolves.toBeTruthy();
    expect(p.callCount('k1')).toBe(3);
    // other keys have their own counter
    await expect(p.generate(req(prompt, { requestKey: 'k2' }))).rejects.toBeInstanceOf(ProviderError);
  });

  it('hangs until aborted for timeout injection, then throws a timeout error', async () => {
    const ac = new AbortController();
    const pending = new MockProvider('mock', { allowFailureInjection: true }).generate(req('q [[mock:fail=timeout]]', { signal: ac.signal })).catch((x) => x);
    setTimeout(() => ac.abort(), 20);
    expect(await pending).toMatchObject({ kind: 'timeout', retryable: true });
  });

  it('returns malformed output that fails schema validation as a non-retryable error', async () => {
    const raw = await new MockProvider('mock', { allowFailureInjection: true }).generate(req('q [[mock:fail=malformed]]'));
    let err: unknown;
    try { parseProviderResponse(raw); } catch (e) { err = e; }
    expect(err).toMatchObject({ kind: 'malformed_output', retryable: false });
  });

  it('can disable failure injection (production safety)', async () => {
    const out = await new MockProvider('mock', { allowFailureInjection: false }).generate(req('q [[mock:fail=server_error]]'));
    expect(parseProviderResponse(out).text.length).toBeGreaterThan(0);
  });
});

describe('ProviderRegistry', () => {
  const reg = createProviderRegistry({
    definitions: [
      { providerId: 'a', adapter: 'mock', enabled: true, models: ['a1', 'a2'] },
      { providerId: 'b', adapter: 'mock', enabled: false, models: ['b1'] },
    ],
  });
  it('resolves selections from config and hides disabled providers', () => {
    expect(reg.resolve()).toEqual([{ providerId: 'a', modelId: 'a1' }, { providerId: 'a', modelId: 'a2' }]);
    expect(reg.resolve('a', 'a2')).toEqual([{ providerId: 'a', modelId: 'a2' }]);
    expect(reg.resolve('a')?.length).toBe(2);
    expect(reg.resolve('b')).toBeNull();
    expect(reg.resolve('a', 'zzz')).toBeNull();
    expect(reg.resolve(undefined, 'a1')).toBeNull();
  });
  it('rejects duplicate providers', () => {
    expect(() => createProviderRegistry({ definitions: [
      { providerId: 'a', adapter: 'mock', enabled: true, models: ['x'] },
      { providerId: 'a', adapter: 'mock', enabled: true, models: ['y'] },
    ] })).toThrow(/Duplicate/);
  });
});
