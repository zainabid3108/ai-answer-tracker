/**
 * Exponential backoff with equal jitter: delay in [exp/2, exp], exp = min(cap, base * 2^(attempt-1)).
 * `attempt` is the 1-based number of the attempt that just failed.
 */
export function computeBackoffMs(attempt: number, baseMs: number, capMs: number, rng: () => number = Math.random): number {
  const a = Math.max(1, Math.floor(attempt));
  const exp = Math.min(capMs, baseMs * 2 ** (a - 1));
  const half = exp / 2;
  return Math.floor(half + rng() * half);
}
