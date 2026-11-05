import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseApiKeys } from '../../src/config/env.js';
import { ConfigError, PRODUCTION_MIN_API_KEY_LENGTH, bootstrapRuntime, validateRuntime } from '../../src/config/runtime.js';
import { createLogger } from '../../src/observability/logger.js';
import { parseProviderResponse } from '../../src/providers/types.js';

const GOOD_KEY = 'k'.repeat(PRODUCTION_MIN_API_KEY_LENGTH);
const prod = (extra: Record<string, string> = {}) =>
  loadEnv({ NODE_ENV: 'production', PROVIDER_MODE: 'real', API_KEYS: `${GOOD_KEY}:tenant-a`, ...extra });

const refusal = (fn: () => unknown): string => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return (e as Error).message;
  }
  throw new Error('expected a refusal');
};

describe('production configuration (M2)', () => {
  it('refuses mock providers in production without the explicit override', () => {
    const msg = refusal(() => validateRuntime(prod({ PROVIDER_MODE: 'mock' }), 'api'));
    expect(msg).toContain('PROVIDER_MODE=mock');
    expect(msg).toContain('ALLOW_MOCK_IN_PRODUCTION');
    expect(() => validateRuntime(prod({ PROVIDER_MODE: 'mock' }), 'worker')).toThrow(ConfigError);
  });

  it('allows the override but warns loudly', () => {
    const cfg = validateRuntime(prod({ PROVIDER_MODE: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true' }), 'api');
    expect(cfg.warnings.join(' ')).toMatch(/SECURITY WARNING.*mock/);
    expect(cfg.allowFailureInjection).toBe(false);
  });

  it('PROVIDER_MODE=real with no real adapters registered fails fast with a clear message', () => {
    const env = prod({ PROVIDER_MODE: 'real' });
    expect(() => validateRuntime(env, 'api')).not.toThrow(); // config itself is fine...
    const msg = refusal(() => bootstrapRuntime(env, 'api')); // ...but there is nothing to serve
    expect(msg).toMatch(/no real provider adapters are registered/);
  });

  it('never allows failure injection in production, even with the mock override', () => {
    const e = prod({ PROVIDER_MODE: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true', ENABLE_MOCK_FAILURE_INJECTION: 'true' });
    expect(refusal(() => validateRuntime(e, 'api'))).toContain('ENABLE_MOCK_FAILURE_INJECTION');
    expect(() => validateRuntime(e, 'worker')).toThrow(ConfigError);
  });

  it.each([
    ['empty', ''],
    ['whitespace/commas only', ' , ,'],
    ['malformed (no tenant)', `${GOOD_KEY}`],
    ['malformed (empty tenant)', `${GOOD_KEY}:`],
    ['invalid tenant charset (pipe)', `${GOOD_KEY}:ten|ant`],
    ['invalid tenant charset (space)', `${GOOD_KEY}:ten ant`],
    ['invalid tenant charset (leading dash)', `${GOOD_KEY}:-tenant`],
    ['key shorter than minimum', 'short-key:tenant-a'],
    ['duplicate keys', `${GOOD_KEY}:tenant-a,${GOOD_KEY}:tenant-b`],
  ])('refuses API_KEYS: %s (production, api role)', (_n, keys) => {
    expect(() => validateRuntime(prod({ API_KEYS: keys }), 'api')).toThrow(ConfigError);
  });

  it('accepts a valid production key set; the worker role does not need API_KEYS', () => {
    const cfg = validateRuntime(prod({ API_KEYS: `${GOOD_KEY}:tenant-a,${'z'.repeat(40)}:tenant_b` }), 'api');
    expect(cfg.apiKeys.map(([, t]) => t)).toEqual(['tenant-a', 'tenant_b']);
    expect(() => validateRuntime(prod({ API_KEYS: '' }), 'worker')).not.toThrow();
  });

  it('error messages never echo key or tenant values', () => {
    const secretKey = 'TOPSECRETKEY-abc123';
    const badTenant = 'bad|tenantVALUE';
    const dupe = 'DUPLICATEDSECRET-key-0123456789abcdef-xyz';
    for (const keys of [`${secretKey}:tenant-a`, `${GOOD_KEY}:${badTenant}`, `${dupe}:t1,${dupe}:t2`]) {
      const msg = refusal(() => validateRuntime(prod({ API_KEYS: keys }), 'api'));
      for (const s of [secretKey, badTenant, dupe, GOOD_KEY]) expect(msg).not.toContain(s);
    }
    const envMsg = refusal(() => loadEnv({ NODE_ENV: 'test', PROVIDER_MODE: 'sekrit-mode-value', ENABLE_MOCK_FAILURE_INJECTION: 'sekrit-flag-value' }));
    expect(envMsg).not.toContain('sekrit-mode-value');
    expect(envMsg).not.toContain('sekrit-flag-value');
    expect(envMsg).toContain('PROVIDER_MODE');
  });

  it('dev/test keep short keys but still reject duplicates and bad tenant ids', () => {
    expect(() => validateRuntime(loadEnv({ NODE_ENV: 'test', API_KEYS: 'dev-key:tenant-demo' }), 'api')).not.toThrow();
    expect(() => validateRuntime(loadEnv({ NODE_ENV: 'test', API_KEYS: 'a1:t,a1:u' }), 'api')).toThrow(ConfigError);
    expect(() => validateRuntime(loadEnv({ NODE_ENV: 'test', API_KEYS: 'a1:t|x' }), 'api')).toThrow(ConfigError);
  });

  it('parseApiKeys collects every problem by entry number', () => {
    const msg = refusal(() => parseApiKeys('aa:t1,aa:t2,bb:bad id', { minKeyLength: 3 }));
    expect(msg).toMatch(/entry 2 duplicates the API key of entry 1/);
    expect(msg).toMatch(/entry 3 has an invalid tenantId/);
    expect(msg).toMatch(/shorter than 3/);
  });
});

describe('failure-injection flag wiring through bootstrapRuntime (M2)', () => {
  const gen = async (env: ReturnType<typeof loadEnv>) => {
    const { registry } = bootstrapRuntime(env, 'worker', createLogger('silent'));
    const p = registry.getProvider('mock-alpha')!;
    return p.generate({ prompt: 'q [[mock:fail=server_error]]', modelId: 'mock-alpha-1', requestKey: 'k', signal: new AbortController().signal });
  };

  it('directives are ignored by default (flag unset) and honoured only when explicitly enabled in dev/test', async () => {
    expect(parseProviderResponse(await gen(loadEnv({ NODE_ENV: 'development' }))).text.length).toBeGreaterThan(0);
    expect(parseProviderResponse(await gen(loadEnv({ NODE_ENV: 'test', ENABLE_MOCK_FAILURE_INJECTION: 'false' }))).text.length).toBeGreaterThan(0);
    await expect(gen(loadEnv({ NODE_ENV: 'test', ENABLE_MOCK_FAILURE_INJECTION: 'true' }))).rejects.toMatchObject({ kind: 'server_error' });
  });
});

describe('server.ts / worker.ts really run the shared checks (wiring)', () => {
  const root = path.resolve(import.meta.dirname, '../..');
  const tsx = path.join(root, 'node_modules/tsx/dist/cli.mjs');
  const run = (entry: string, env: Record<string, string>) =>
    spawnSync(process.execPath, [tsx, path.join(root, 'src', entry)], {
      cwd: root,
      encoding: 'utf8',
      timeout: 45_000,
      // Unreachable infra on purpose: a correct implementation refuses BEFORE connecting to anything.
      env: { PATH: process.env.PATH ?? '', SystemRoot: process.env.SystemRoot ?? '', MONGO_URL: 'mongodb://127.0.0.1:1', REDIS_URL: 'redis://127.0.0.1:1', LOG_LEVEL: 'silent', ...env },
    });

  const secret = 'WIRING-SECRET-key-value';
  const cases: Array<[string, string, Record<string, string>, RegExp]> = [
    ['server', 'server.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'mock', API_KEYS: `${GOOD_KEY}:tenant-a` }, /PROVIDER_MODE=mock/],
    ['server', 'server.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true', API_KEYS: `${secret}:tenant-a` }, /API_KEYS/],
    ['server', 'server.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'real', API_KEYS: `${GOOD_KEY}:tenant-a` }, /no real provider adapters/],
    ['server', 'server.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true', ENABLE_MOCK_FAILURE_INJECTION: 'true', API_KEYS: `${GOOD_KEY}:tenant-a` }, /ENABLE_MOCK_FAILURE_INJECTION/],
    ['worker', 'worker.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'mock' }, /PROVIDER_MODE=mock/],
    ['worker', 'worker.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'real' }, /no real provider adapters/],
    ['worker', 'worker.ts', { NODE_ENV: 'production', PROVIDER_MODE: 'mock', ALLOW_MOCK_IN_PRODUCTION: 'true', ENABLE_MOCK_FAILURE_INJECTION: 'true' }, /ENABLE_MOCK_FAILURE_INJECTION/],
    ['server', 'server.ts', {}, /NODE_ENV: must be set explicitly/],
    ['server', 'server.ts', { NODE_ENV: '' }, /NODE_ENV: must be set explicitly/],
    ['server', 'server.ts', { NODE_ENV: 'staging' }, /NODE_ENV: must be set explicitly/],
    ['server', 'server.ts', { NODE_ENV: 'Production' }, /NODE_ENV: must be set explicitly/],
    ['worker', 'worker.ts', {}, /NODE_ENV: must be set explicitly/],
    ['worker', 'worker.ts', { NODE_ENV: '' }, /NODE_ENV: must be set explicitly/],
    ['worker', 'worker.ts', { NODE_ENV: 'staging' }, /NODE_ENV: must be set explicitly/],
    ['worker', 'worker.ts', { NODE_ENV: 'Production' }, /NODE_ENV: must be set explicitly/],
  ];

  it.each(cases)('%s refuses to start: %s', (_role, entry, env, expected) => {
    const r = run(entry, env);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(expected);
    expect(r.stderr + r.stdout).not.toContain(secret);
    expect(r.stderr).not.toMatch(/ECONNREFUSED|MongoServerSelection/); // never got as far as connecting
  }, 60_000);
});
