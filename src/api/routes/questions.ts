import { Router } from 'express';
import { z } from 'zod';
import { DEFAULT_BRAND_LIMITS, type BrandLimits } from '../../domain/brands.js';
import type { QuestionApi } from '../../services/questionService.js';
import type { InflightGate } from '../middleware/rateLimit.js';

const idStr = z.string().min(1).max(100).regex(/^[A-Za-z0-9_-]+$/);

export interface InputLimits {
  maxQuestionChars: number;
  brand: BrandLimits;
}

export const DEFAULT_INPUT_LIMITS: InputLimits = { maxQuestionChars: 4000, brand: DEFAULT_BRAND_LIMITS };

export function createSubmitSchema(limits: InputLimits = DEFAULT_INPUT_LIMITS) {
  const b = limits.brand;
  const aliasValue = z.string().min(b.minAliasLength).max(b.maxAliasLength);
  const BrandSchema = z.object({
    brandId: idStr.optional(),
    name: z.string().trim().min(1).max(b.maxNameLength),
    aliases: z.array(z.union([aliasValue, z.object({ value: aliasValue, caseSensitive: z.boolean().optional() })])).max(b.maxAliasesPerBrand).optional(),
    exclusions: z.array(z.string().min(1).max(b.maxAliasLength)).max(b.maxExclusionsPerBrand).optional(),
  });
  return z
    .object({
      question: z.string().trim().min(1).max(limits.maxQuestionChars),
      brands: z.array(BrandSchema).max(b.maxBrands).optional(),
      providerId: idStr.optional(),
      modelId: z.string().min(1).max(100).optional(),
      questionVersion: z.number().int().min(1).max(1_000_000).optional(),
    })
    .strict()
    .refine((v) => !(v.modelId && !v.providerId), { message: 'modelId requires providerId', path: ['modelId'] });
}

export const SubmitSchema = createSubmitSchema();

const WaitQuery = z.enum(['0', '1', 'true', 'false']).optional();
const REQUEST_ID = /^[0-9a-f-]{36}$/;

export interface QuestionsRouterOptions {
  limits?: InputLimits;
  /** Caps concurrent sync waits; when saturated the request is accepted but answered 202 immediately. */
  inflight?: InflightGate;
}

export function questionsRouter(service: QuestionApi, opts: QuestionsRouterOptions = {}): Router {
  const r = Router();
  const schema = opts.limits ? createSubmitSchema(opts.limits) : SubmitSchema;

  r.post('/v1/questions', async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const input = schema.parse(req.body); // ZodError -> 400 in error handler
    const waitParam = WaitQuery.parse(req.query.wait); // ?wait=0 -> accept and return 202 without waiting
    let wait = waitParam !== '0' && waitParam !== 'false';

    let release: (() => void) | null = null;
    let waitSkipped: string | undefined;
    if (wait && opts.inflight) {
      release = opts.inflight.tryAcquire(tenantId);
      if (!release) {
        wait = false;
        waitSkipped = 'inflight_limit'; // degrade to async: work is still accepted, client polls GET
      }
    }
    const ac = new AbortController();
    const onClose = () => {
      if (!res.writableFinished) ac.abort(); // client went away: stop polling Mongo for it
    };
    res.on('close', onClose);
    try {
      const out = await service.submit(tenantId, input, { wait, signal: ac.signal });
      if (waitSkipped) res.setHeader('X-Wait-Skipped', waitSkipped);
      res.status(out.complete ? 200 : 202).json(waitSkipped ? { ...out, waitSkipped } : out);
    } finally {
      release?.();
      res.off('close', onClose);
    }
  });

  r.get('/v1/questions/:id', async (req, res) => {
    const tenantId = res.locals.tenantId as string;
    const id = String(req.params.id);
    // Unknown and foreign ids are indistinguishable: both 404.
    const view = REQUEST_ID.test(id) ? await service.get(tenantId, id) : null;
    if (!view) {
      res.status(404).json({ error: { code: 'not_found', message: 'Request not found' } });
      return;
    }
    res.json(view);
  });

  return r;
}
