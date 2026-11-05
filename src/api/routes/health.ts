import { Router } from 'express';

export interface ReadinessCheck {
  name: string;
  check: () => Promise<void>;
}

export function healthRouter(checks: ReadinessCheck[]): Router {
  const r = Router();
  r.get('/healthz', (_req, res) => {
    res.json({ status: 'ok' });
  });
  r.get('/readyz', async (_req, res) => {
    const results = await Promise.all(
      checks.map(async (c) => {
        try {
          await Promise.race([c.check(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000).unref())]);
          return [c.name, 'ok'] as const;
        } catch {
          return [c.name, 'unavailable'] as const;
        }
      }),
    );
    const ready = results.every(([, s]) => s === 'ok');
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks: Object.fromEntries(results) });
  });
  return r;
}
