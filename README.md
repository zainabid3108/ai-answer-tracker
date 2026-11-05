# AI Answer Tracker

A backend service that sends buyer questions to multiple AI providers, detects which brands each answer mentions, and records the URLs it cites.

> **Status: Milestone 1 (development baseline).** Only deterministic **mock** providers exist. The system is **not production-ready** — see [Known limitations](#known-limitations).

## How it works

```
Client ──POST /v1/questions──▶ API (Express)
                                 │  1. auth (x-api-key → tenant), rate limit, validate
                                 │  2. insert ledger row (MongoDB, status=queued)
                                 │  3. enqueue one job per provider/model (BullMQ + Redis)
                                 ▼
                          Worker (BullMQ)
                                 │  4. claim row, call provider (timeout, retry, 429 handling)
                                 │  5. analyze brands + normalize citations
                                 │  6. persist answer, mentions, citations → status=succeeded
                                 ▼
Client ◀──GET /v1/questions/:id── API (poll, or wait inline for up to API_SYNC_WAIT_MS)
```

- A question fans out to every enabled provider/model (or a selected one).
- Brand mentions are matched deterministically (Unicode word boundaries, aliases, exclusion phrases, URLs masked).
- Citations are the union of provider-supplied citations and URLs found in the text, normalized (tracking params removed) and deduplicated.
- Exhausted or non-retryable jobs go to a dead-letter queue (`llm-dlq`).

## Tech stack

Node.js (>= 20), TypeScript, Express 5, MongoDB, Redis + BullMQ, Zod, pino, Vitest.

## Project structure

```
src/
  server.ts            API process entry point
  worker.ts            Worker process entry point
  api/                 Express app, routes, auth and rate-limit middleware
  services/            Submit / get orchestration
  queue/               BullMQ queues, enqueue + dead-letter ports
  workers/             LLM job processor (retries, fencing, DLQ recovery)
  providers/           Provider interface, registry, mock provider
  domain/              Pure logic: brand matcher, citations, idempotency, retry
  db/                  Mongo connection, indexes, tenant-scoped repositories
  config/              Env parsing and startup safety checks
  observability/       Structured logger (pino, with redaction)
tests/
  unit/                Pure and API tests
  integration/         Pipeline, resilience, snapshot/limit tests (need Redis)
docs/decisions.md      Technical decisions, review fixes, accepted limitations
```

## Getting started

### Prerequisites

- Node.js 20+
- MongoDB (default `mongodb://127.0.0.1:27017`)
- Redis (default `redis://127.0.0.1:6379`)

### Setup

```bash
npm install
cp .env.example .env     # then edit; never commit real secrets
```

`NODE_ENV` is **required** (`development`, `test` or `production`); the API and worker refuse to start without it.

### Run

Run the API and the worker as separate processes:

```bash
npm run dev:api      # http://localhost:3000
npm run dev:worker
```

Production-style build:

```bash
npm run build        # compiles to dist/
```

## Configuration

All configuration is via environment variables (see [.env.example](.env.example) for the full list and defaults).

| Variable | Purpose |
| --- | --- |
| `NODE_ENV` | Required. `development` \| `test` \| `production` |
| `PORT`, `LOG_LEVEL` | HTTP port and log level |
| `MONGO_URL`, `MONGO_DB` | MongoDB connection |
| `REDIS_URL`, `QUEUE_PREFIX` | Redis connection and BullMQ key prefix |
| `API_KEYS` | Stub auth: comma-separated `apiKey:tenantId` pairs (keys ≥ 32 chars in production) |
| `PROVIDER_MODE` | `mock` (default) or `real` (no real adapters yet — fails fast) |
| `ALLOW_MOCK_IN_PRODUCTION` | Explicit override to run mocks with `NODE_ENV=production` |
| `ENABLE_MOCK_FAILURE_INJECTION` | Enables `[[mock:...]]` prompt directives (dev/test only) |
| `PROVIDER_TIMEOUT_MS`, `LOCK_DURATION_MS` | Provider call timeout; job lock (must be larger, identical for API and worker) |
| `MAX_ATTEMPTS`, `BACKOFF_BASE_MS`, `BACKOFF_MAX_MS`, `MAX_RATE_LIMIT_HITS` | Retry and backoff behaviour |
| `WORKER_CONCURRENCY` | Concurrent jobs per worker |
| `RATE_LIMIT_*`, `MAX_INFLIGHT_WAITS_*` | In-process API protection |
| `BODY_LIMIT_BYTES`, `MAX_QUESTION_CHARS`, `MAX_TARGETS_PER_REQUEST`, `MAX_BRANDS`, `MAX_ALIASES_PER_BRAND`, `MAX_TOTAL_ALIASES` | Input limits |

Provider API keys (e.g. `OPENAI_API_KEY`) belong in environment variables only and are never logged.

## API

All `/v1` routes require an `x-api-key` header; the key maps to a tenant, and all data is tenant-isolated.

### `POST /v1/questions`

Submit a question. Body:

```json
{
  "question": "What are the best CRM tools for small teams?",
  "brands": [
    { "name": "Acme", "aliases": ["Acme CRM", { "value": "ACME", "caseSensitive": true }], "exclusions": ["acme pie"] }
  ],
  "providerId": "mock-beta",
  "modelId": "mock-beta-1",
  "questionVersion": 1
}
```

`providerId`, `modelId`, `brands` and `questionVersion` are optional (`modelId` requires `providerId`). Omitting the provider fans out to all enabled targets.

- `200` — all targets finished; results included.
- `202` — still processing; poll `GET /v1/questions/:id`. Use `?wait=0` to skip the inline wait.
- Errors use `{ "error": { "code", "message" } }` (`400`, `401`, `413`, `429` with `Retry-After`).

Submissions are **idempotent**: the same tenant, question, version, provider, model, run date and sample index never gets processed twice. Bump `questionVersion` to force a new run (e.g. after changing brands).

### `GET /v1/questions/:id`

Returns status, answer text, brand mentions (count, rank, first position, snippet) and citations (raw and normalized URL, domain). Unknown and foreign ids both return `404`.

### Health

- `GET /healthz` — liveness
- `GET /readyz` — readiness (Mongo and Redis checks)

## Testing

```bash
npm run typecheck
npm run test:unit   # no external services needed
npm test            # all tests; Redis integration suites skip if Redis is unreachable
npm run test:ci     # same, but a missing Redis FAILS the run (REQUIRE_REDIS=true)
```

MongoDB is provided in tests by `mongodb-memory-server`. Set `TEST_REDIS_URL` to point tests at a different Redis.

## Reliability and security design

- **Idempotency:** unique `(tenantId, idempotencyKey)` index plus the BullMQ job id derived from the same hash.
- **Retries:** exponential backoff with jitter; 429s defer the queue without consuming an attempt; non-retryable errors go straight to the dead-letter queue.
- **Timeouts and stalls:** provider calls are aborted after `PROVIDER_TIMEOUT_MS`; ownership tokens fence zombie deliveries.
- **Tenant isolation:** repositories always filter by `tenantId`.
- **Logging:** structured pino logs with redaction; question text, answer bodies and secrets are never logged.
- **Safe startup:** unsafe configuration (mock providers in production, weak API keys, failure injection) is rejected at boot.

## Known limitations

- Only mock providers; `PROVIDER_MODE=real` fails fast until real adapters are added.
- Auth is a stub (static API keys).
- Rate limits and in-flight caps are per-process; multi-instance deployments need a shared store.
- Stranded `queued`/`running` rows have no reconciler yet; no graceful shutdown or metrics export.

Full details, trade-offs and the backlog are in [docs/decisions.md](docs/decisions.md).
