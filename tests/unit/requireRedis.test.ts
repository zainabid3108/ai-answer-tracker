import { describe, expect, it, vi } from 'vitest';
import { parseRequireRedis, resolveRedisAvailability } from '../helpers/stack.js';

const URL_ = 'redis://user:pw-secret@127.0.0.1:1';
const down = async () => false;
const up = async () => true;

describe('REQUIRE_REDIS test-helper behaviour', () => {
  it('parses the flag strictly', () => {
    expect(parseRequireRedis(undefined)).toBe(false);
    expect(parseRequireRedis('')).toBe(false);
    expect(parseRequireRedis('false')).toBe(false);
    expect(parseRequireRedis('true')).toBe(true);
    expect(() => parseRequireRedis('1')).toThrow(/REQUIRE_REDIS/);
    expect(() => parseRequireRedis('TRUE')).toThrow(/REQUIRE_REDIS/);
  });

  it('returns true when Redis is reachable, in both modes', async () => {
    expect(await resolveRedisAvailability({ url: URL_, require: false, probe: up })).toBe(true);
    expect(await resolveRedisAvailability({ url: URL_, require: true, probe: up })).toBe(true);
  });

  it('skips with a warning when unreachable and not required', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(await resolveRedisAvailability({ url: URL_, require: false, probe: down })).toBe(false);
      expect(warn).toHaveBeenCalledOnce();
      expect(String(warn.mock.calls[0]![0])).toContain('127.0.0.1:1');
    } finally {
      warn.mockRestore();
    }
  });

  it('fails with a clear error (no credentials) when unreachable and required', async () => {
    const err = await resolveRedisAvailability({ url: URL_, require: true, probe: down }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/REQUIRE_REDIS=true but Redis is unreachable at 127\.0\.0\.1:1/);
    expect((err as Error).message).not.toContain('pw-secret');
  });
});
