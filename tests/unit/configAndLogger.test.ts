import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { loadEnv, parseApiKeys } from '../../src/config/env.js';
import { createLogger } from '../../src/observability/logger.js';
import { parseRedisUrl, llmQueueName } from '../../src/queue/queues.js';

describe('loadEnv', () => {
  it('applies defaults', () => {
    const e = loadEnv({ NODE_ENV: 'test' });
    expect(e.PORT).toBe(3000);
    expect(e.LOCK_DURATION_MS).toBeGreaterThan(e.PROVIDER_TIMEOUT_MS);
  });

  it('rejects lock duration not above provider timeout', () => {
    expect(() => loadEnv({ NODE_ENV: 'test', PROVIDER_TIMEOUT_MS: '30000', LOCK_DURATION_MS: '30000' })).toThrow(/LOCK_DURATION_MS/);
  });

  it('does not echo secret values in validation errors', () => {
    try {
      loadEnv({ NODE_ENV: 'test', PORT: 'sekrit-value-123' });
      throw new Error('should have thrown');
    } catch (e) {
      expect((e as Error).message).toContain('PORT');
      expect((e as Error).message).not.toContain('sekrit-value-123');
    }
  });
});

describe('parseApiKeys', () => {
  it('parses pairs and rejects malformed entries', () => {
    expect(parseApiKeys('k1:t1, k2:t2')).toEqual([['k1', 't1'], ['k2', 't2']]);
    expect(parseApiKeys('')).toEqual([]);
    expect(() => parseApiKeys('nocolon')).toThrow();
  });
});

describe('queue naming / redis url', () => {
  it('never produces a colon in queue names', () => {
    expect(llmQueueName('mock-alpha')).toBe('llm-mock-alpha');
    expect(llmQueueName('x').includes(':')).toBe(false);
  });
  it('parses redis urls', () => {
    expect(parseRedisUrl('redis://:pw@h:6380/2')).toMatchObject({ host: 'h', port: 6380, password: 'pw', db: 2 });
  });
});

describe('logger redaction', () => {
  it('redacts secrets and content fields', () => {
    const chunks: string[] = [];
    const sink = new Writable({ write(c, _e, cb) { chunks.push(String(c)); cb(); } });
    const log = createLogger('info', sink);
    log.info({ apiKey: 'SECRET-KEY', questionText: 'private question', nested: { token: 'TOK' }, requestId: 'r1' }, 'evt');
    const out = chunks.join('');
    expect(out).not.toContain('SECRET-KEY');
    expect(out).not.toContain('private question');
    expect(out).not.toContain('TOK');
    expect(out).toContain('r1');
  });
});

describe('NODE_ENV validation', () => {
  const msg = (env: Record<string, string | undefined>) => {
    try {
      loadEnv(env);
    } catch (e) {
      return (e as Error).message;
    }
    return undefined;
  };

  it.each(['development', 'test', 'production'] as const)('accepts %s', (v) => {
    expect(loadEnv({ NODE_ENV: v }).NODE_ENV).toBe(v);
  });

  it.each([
    ['missing', {}],
    ['undefined', { NODE_ENV: undefined }],
    ['empty', { NODE_ENV: '' }],
    ['unknown value', { NODE_ENV: 'staging' }],
    ['wrong case', { NODE_ENV: 'Production' }],
    ['padded', { NODE_ENV: ' production' }],
  ])('rejects %s with a clear message', (_name, env) => {
    expect(msg(env)).toMatch(/NODE_ENV: must be set explicitly to one of: development, test, production/);
  });

  it('does not echo the invalid value', () => {
    expect(msg({ NODE_ENV: 'sekrit-env-value' })).not.toContain('sekrit-env-value');
  });
});
