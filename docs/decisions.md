# Technical decisions and assumptions (Milestone 1)

Every item marked **Revisit before production** is a deliberate simplification of the approved plan, not a final answer.

## Assumptions

1. **Platform-owned provider keys.** Provider credentials (when real adapters exist) are platform env vars, not per-tenant. Milestone 1 uses no keys at all. *Revisit before production.*
2. **UTC scheduling and dates.** `runDate` is the UTC calendar date at submission time; it is part of the idempotency key. *Revisit before production* (tenant-local reporting days are a reporting concern, not a scheduling one).
3. **One sample per question/model/day.** `sampleIndex` is fixed at 0. Resubmitting the same question to the same model on the same UTC day returns the existing request instead of re-querying. The index shape already allows more samples later. *Revisit before production.*
4. **Mock providers only.** `src/providers/mockProvider.ts` is the only adapter; no network calls to AI vendors. Failure-injection directives (`[[mock:...]]`) are OFF unless `ENABLE_MOCK_FAILURE_INJECTION=true`, which is refused in production (see "Review fixes" M2). *Revisit before production* (a real prompt must never be able to trigger behaviour; real adapters still have to be written).
5. **Brand discovery and archival deferred.** Matching is deterministic against predefined brands + aliases only. No LLM discovery, no S3/archive, scheduler, rollups, quotas or reconciler. *Revisit before production.*
6. **Sync-wait API semantics.** `POST /v1/questions` creates the ledger rows, enqueues, then polls the ledger (status-only reads, `100 ms`) for up to `API_SYNC_WAIT_MS`. All requests terminal -> `200`; otherwise `202` with request ids and the client polls `GET /v1/questions/:id`. `?wait=0` skips the wait entirely. Polling Mongo was chosen over `QueueEvents` for simplicity and because Mongo is the source of truth. *Revisit before production* (long-lived HTTP waits do not scale; consider async-only plus webhooks/SSE).
7. **API-key auth is a placeholder.** `x-api-key` is matched (sha256 + `timingSafeEqual`) against `API_KEYS=key:tenantId,...` from env. No rotation, scopes, per-key rate limits or storage. The tenantId always comes from the key, never from the body (unknown body fields are rejected). *Revisit before production.*

## Implementation decisions (original)

- **Queue names use `-`, not `:`.** BullMQ 6 throws `Queue name cannot contain :`, so `llm:<providerId>` is `llm-<providerId>`; the DLQ is `llm-dlq`. Deviation from the plan; same semantics.
- **Idempotency.** `sha256(tenantId|questionId|questionVersion|providerId|modelId|runDate|sampleIndex)`. Components containing `|` are rejected. The unique Mongo index `(tenantId, idempotencyKey)` is the guarantee; the BullMQ `jobId` is the same hash (hex, no `:`) as a secondary guard. `questionId` is a tenant-scoped hash of the normalized question text; clients may bump `questionVersion` to force a new identity (e.g. after changing brands), because brands are snapshotted on the ledger row at first submission.
- **Ledger-first ordering.** Insert (status `queued`) then enqueue. If the process dies between them, a repeat submission finds the `queued` row and re-adds the job (same jobId, so no-op if it already exists). A reconciler for orphans is out of scope.
- **Persistence is repeatable, not transactional.** Standalone Mongo has no transactions, so answer/mentions/citations are upserts keyed by `(tenantId, requestId[, brand|url])` and the ledger flips to `succeeded` last. A crash mid-way is repaired by the next attempt without duplicates.
- **Retry classification.** Retryable: `rate_limited`, `server_error`, `timeout`, unknown internal errors. Non-retryable (`UnrecoverableError`): `content_filtered`, `bad_request`, `auth`, `malformed_output`. Malformed output is treated as non-retryable in M1; revisit once real provider behaviour is observed.
- **Backoff.** Exponential with equal jitter (`[exp/2, exp]`, capped), implemented as a BullMQ custom `backoffStrategy` (`expJitter`).
- **429 handling.** The worker calls `worker.rateLimit(retryAfterMs)` and throws `Worker.RateLimitError()`: the job returns to the queue without consuming an attempt, and that provider's queue pauses for the Retry-After window. The ledger counts these separately (`rateLimitHits` vs `attempts`); after `MAX_RATE_LIMIT_HITS` the request fails with class `rate_limited` so a permanently throttled provider cannot loop forever.
- **Timeouts.** The worker aborts provider calls after `PROVIDER_TIMEOUT_MS`; `LOCK_DURATION_MS` must be greater (validated at startup and by `startLlmWorker`) so a slow call is never mistaken for a stalled job.
- **Tenant isolation.** Repositories are the only Mongo access; every method takes `tenantId` first, rejects empty values, and includes it in every filter. Foreign and unknown request ids both return `404`. (One deliberate exception: `listPendingDeadLetters`, a system-level sweep, is cross-tenant and its rows are then handled strictly per tenant.)
- **Logging.** pino with redaction of secret/content fields. Logs carry IDs, status, error class and timings only; never question text or answer bodies. Provider/API error messages returned to clients are generic.
- **Brand matching.** Unicode word boundaries (`\p{L}\p{N}_`), NFC normalization, names case-insensitive, aliases opt-in case-sensitive, longest-match wins across overlapping spans/brands, per-brand exclusion phrases. Positions index into the NFC-normalized answer text (which is what is stored).
- **URLs.** WHATWG URL parsing (punycode hosts), tracking params (`utm_*`, `gclid`, `fbclid`, ...) and fragments removed, default ports dropped, query sorted, trailing slash removed. `domain` is the host minus a leading `www.` (no public-suffix list yet). Citations are the union of provider-supplied citations and URLs found in text, deduped by normalized URL.

## Review fixes (post-review of Milestone 1)

### H1 - stalled / redelivered jobs no longer strand ledger rows
*Files: `src/db/repositories/answerRequests.ts`, `src/workers/llmWorker.ts`, `src/services/questionService.ts`, `src/domain/types.ts`.*

- **Ownership.** `claim()` now records `ownerJobId` (BullMQ job id, stable across redeliveries) and `ownerToken` (BullMQ lock token, unique per delivery). A claim succeeds when the row is `queued`, **or** `running` under the *same job id* (the previous delivery of this very job is presumed dead - stalled or lock lost), **or** `running` and stale (`startedAt` older than `staleRunningMs` = 2 x `LOCK_DURATION_MS`).
- **Fencing.** `markSucceeded`, `markFailed` and `requeue` only apply when `ownerToken` still matches. A zombie delivery that wakes up after being superseded cannot finish, fail or requeue the row; its answer/mention/citation writes are idempotent upserts so no duplicates arise. A `false` result is logged (`ledger_update_not_applied_*`, L1) and, for success, the handler reports `skipped`.
- **No silent skip.** If the row is freshly `running` under a *different* job, the handler no longer returns `skipped`. It parks the job with `job.moveToDelayed()` + `DelayedError` until the row would count as stale, then re-evaluates (BullMQ delayed move; its attempt accounting was not separately verified). Terminal rows are still skipped without calling the provider.
- **Mongo failures in the handler.** If `requeue`/`markFailed` throw, the original error is rethrown (a plain error, so BullMQ redelivers); the row is still `running` under the same job id, so the redelivery reclaims it. `claim` errors simply fail the attempt.
- **Orphaned rows (job gone for good).** BullMQ gives up after `maxStalledCount` and fails the job *without* running our handler. `submit()` now detects a `running` row older than `staleRunningMs`, atomically flips it back to `queued` and bumps `enqueueEpoch` (`reclaimStale`, exactly one racer wins), and enqueues under a fresh job id `<idempotencyKey>-e<epoch>` so the lingering dead job (same-id add is a no-op) cannot block it. Epoch 0 keeps the original id.
- **Config coupling.** The API's `staleRunningMs` must equal the worker's (both `2 x LOCK_DURATION_MS`). Keep `LOCK_DURATION_MS` identical in both processes.
- **Known gap.** A *queued* row whose BullMQ job was lost/failed (e.g. stalled out after a requeue) is not re-enqueued under a new epoch; only `running` rows are. More broadly, stranded `running`/`queued` rows can persist **indefinitely** (see "Accepted limitations - Milestone 1").

### H2 - brand id collisions
*Files: `src/domain/brands.ts`, `src/services/questionService.ts`.*

- Fallback id is `b_<first 24 hex of sha256>` of the NFC-normalized, whitespace-collapsed, lower-cased name. It replaces the lossy ASCII slug (which mapped every CJK/Arabic/Cyrillic name to `brand`). NFC/NFD and case variants of one name share an id; `Cafe` and `Café` do not.
- Duplicate ids (client-supplied or derived, so also same-name brands) are rejected at validation with `400 duplicate_brand_id`. The message cites array positions, never brand text. Identical names are therefore *rejected consistently*, not silently merged. Brand ids created by the old slug are unaffected (only used when no `brandId` is supplied; stored snapshots keep their ids).

### M1 - dead-letter write failure is recoverable
*Files: `src/workers/llmWorker.ts`, `src/db/repositories/answerRequests.ts`, `src/db/indexes.ts`, `src/worker.ts`.*

- `markFailed` sets `deadLettered=false` (and its boolean result is checked). `ensureDeadLettered()` adds the DLQ entry (deterministic jobId = idempotency hash, so repeats never duplicate) and then `markDeadLettered`.
- If the DLQ add throws, the handler rethrows a *plain* error: BullMQ redelivers while attempts remain and the terminal-skip path (`row.status=failed && deadLettered=false`) writes the entry. If attempts run out first, `recoverPendingDeadLetters()` (run by `src/worker.ts` at start-up and every 60 s, partial index `pending_dead_letters`) repairs it. The sweep is safe to run from several workers.
- Legacy `failed` rows without the `deadLettered` field are not touched by the sweep.

### M2 - strict production configuration
*Files: `src/config/env.ts`, `src/config/runtime.ts` (new, shared), `src/providers/registry.ts`, `src/providers/types.ts`, `src/providers/mockProvider.ts`, `src/server.ts`, `src/worker.ts`.*

`bootstrapRuntime(env, role)` runs **before any connection** in both `server.ts` (`api`) and `worker.ts` (`worker`). It refuses to start when:
- `NODE_ENV=production` and `PROVIDER_MODE=mock` without `ALLOW_MOCK_IN_PRODUCTION=true` (with the override it starts and logs a `SECURITY WARNING`);
- `ENABLE_MOCK_FAILURE_INJECTION=true` in production (never allowed, not even with the mock override);
- `PROVIDER_MODE=real` while no real adapters are registered (`REAL_PROVIDER_DEFINITIONS` is empty in M1 - clear fail-fast message instead of silently serving mocks);
- (API role) `API_KEYS` is empty in production, malformed, has duplicate keys, a `tenantId` outside `[A-Za-z0-9][A-Za-z0-9_-]{0,63}` (no `|`, `:` or spaces), or - in production - a key shorter than 32 characters.

Errors list problems by entry *number* and variable *name*; key and tenant values are never echoed (tested). Decisions: tenantId/duplicate rules apply in every environment, the length rule only in production (the dev placeholder key is short); the worker role skips `API_KEYS` checks because it never authenticates callers (deviation from "same checks" - a worker without `API_KEYS` still boots). `MockProvider` and the registry now default failure injection to **off** (it used to default on); tests opt in explicitly. The wiring is tested by spawning `src/server.ts` / `src/worker.ts` and asserting exit code 1 and the message, with unreachable Mongo/Redis to prove nothing connected first.

### M4 - basic API protection
*Files: `src/api/app.ts`, `src/api/middleware/rateLimit.ts` (new), `src/api/middleware/auth.ts`, `src/api/routes/questions.ts`, `src/services/questionService.ts`.*

- **Rate limiting** (in-process fixed window): per tenant for every authenticated route (GET polls included), plus a per-IP fallback that counts only *failed* authentications (throttles key guessing, does not penalise tenants behind one IP). Over limit -> `429`, `Retry-After` (seconds), code `rate_limited`. Health endpoints are exempt. Placed after auth and before body parsing.
- **In-flight sync waits** capped per tenant and globally. Excess requests are still accepted but answered `202` immediately with `waitSkipped: "inflight_limit"` (and `X-Wait-Skipped`), instead of failing. Slots are released in `finally`; a client disconnect aborts the wait loop.
- **`?wait=0|false`** returns `202` without waiting (still `200` if everything is already terminal). Other values -> `400`.
- **Input limits:** question length (`MAX_QUESTION_CHARS`), provider/model targets per request (`MAX_TARGETS_PER_REQUEST`, `400 too_many_targets`), brands/aliases counts (below), body size (`BODY_LIMIT_BYTES`) -> `413 payload_too_large` (distinct from malformed JSON `400 bad_request`, L5).
- **Cheaper polling (L3):** the wait loop reads only `{_id,status}`; the full result view (answer, mentions, citations) is built once at the end.
- **Limitation (document + revisit before production):** limiter and in-flight counters live in process memory. With N API instances the effective limits are N x configured, restarts reset them, and behind a proxy `trust proxy` must be configured for `req.ip`. A multi-instance deployment needs a shared store (e.g. Redis token bucket).

### M5 - brand snapshot conflict
*Files: `src/domain/brands.ts`, `src/services/questionService.ts`, `src/db/repositories/answerRequests.ts`, `src/api/app.ts`.*

- Each ledger row stores `brandsHash` = sha256 over canonical brands (sorted by id; NFC; aliases and exclusions de-duplicated and sorted). Order- and Unicode-form-insensitive. Returned as `brandsHash` on every request view.
- A repeat submission (same idempotency key) with a different hash -> `409 brand_snapshot_conflict` with `storedBrandsHash`, `submittedBrandsHash`, `questionVersion` (no brand contents). Bump `questionVersion` to start a new run. Identical sets stay idempotent.
- Requests without inline brands hash the tenant's current brand list and are compared the same way (message says the tenant brand list changed).
- Order: read-only pre-check of existing rows (a conflict creates no work for other targets), then `createOrGet` (first insert wins; a racing loser compares the winner's hash and gets 409). Non-conflicting targets of the same call are still enqueued.
- Legacy rows without `brandsHash` get it computed from their stored brands on read.

### M6 - matcher workload limits
*Files: `src/domain/brandMatcher.ts`, `src/domain/brands.ts`, `src/api/routes/questions.ts`.*

- Validation limits (env-configurable where noted): brands per request/tenant (`MAX_BRANDS`=100), aliases per brand (`MAX_ALIASES_PER_BRAND`=50), total aliases (`MAX_TOTAL_ALIASES`=500), alias length 2..100 (1-char aliases rejected with `alias_too_short`), exclusions 50/brand and 500 total. Tenant-stored brands go through the same validation (`422 tenant_brands_invalid` if they violate current limits).
- Matcher caps (`MatcherLimits`): analyzed text 100 000 UTF-16 units, 1 000 matches per term, 20 000 candidates overall. Hitting any sets `truncated`, stored on the answer (`analysisTruncated`) and returned as `result.truncated`. Counts are then a lower bound.
- Resolution is no longer O(n^2): accepted spans are kept sorted by start and only the two neighbours are checked by binary search (O(n log n) comparisons; array insertion is a cheap memmove at the 20 000 cap); exclusion coverage uses a prefix-max index. A randomized test compares results to a verbatim copy of the previous algorithm; a worst-case workload test bounds runtime.

### M7 - brand mentions ignore URLs (answer-text mentions vs citation-domain appearances)
*Files: `src/domain/brandMatcher.ts`, `src/domain/citations.ts`.* Found in a smoke test: `Globex` was "mentioned" only inside `https://news.globex.test:443/...`, inflating counts and rank.

- **Answer-text mention** = a brand occurrence in the visible prose of the answer, with URLs masked. This is what `brandMentions` (count, rank, firstPosition, snippet) means.
- **Citation-domain appearance** = a brand/domain present in the cited URLs/domains. It is stored separately in `citations` (unchanged). A future analytics metric may relate citation domains to brands; it is NOT computed in Milestone 1.
- **URL definition (single source of truth: `findUrlSpans` in `citations.ts`).** `https?://` followed by any run of characters except whitespace and `<>"'` and backtick, then trailing prose punctuation trimmed (`. , ; : ! ? ' " *`, and `) ] }` only when unbalanced inside the URL). Citation extraction (`extractUrlsFromText`) uses exactly these spans, so its output is unchanged. For masking only, `includeBareWww` also reports scheme-less `www.` links (not preceded by a letter/digit/`_`/`.`/`@`/`/`/`-`). Bare `www.` links are still not extracted as citations. `trimTrailingPunctuation` was rewritten to run in linear time (same output) because the matcher now exposes it to 100k-character hostile input.
- **Offset-preserving masking.** After NFC normalization and truncation, URL spans are overwritten with the same number of `U+0000` characters (`maskUrls`). Matching (names, aliases, exclusions) runs on the masked copy; `firstPosition` and snippets refer to / are cut from the original (NFC) text. The stored answer text is never altered. `U+0000` is a non-word character, so a masked span acts as a separator: `foo<URL>bar` does not fuse, `Globex<URL>` still ends on a boundary, and multi-word terms (`Acme Cloud`) cannot match across a URL.
- **Markdown/autolinks/parentheses.** In `[text](url)` the text stays matchable and the target is masked; `<url>`, `(url)`, `"url"` and URLs followed by punctuation mask only the URL itself.
- **Bare-domain decision.** A token like `Globex.com` or `globex.com/pricing` (no `http(s)://`, no `www.`) is NOT a URL by this definition and stays matchable as text. Rationale: it is how a model names a company in prose, and guessing domains from arbitrary dotted tokens would hide real mentions (`Node.js`, `Dr. Pepper`). Cost: a scheme-less link like `globex.test/x` still counts as a mention.
- **Known limitations.** Scheme-less markdown targets (`[a](globex.test/x)`), other schemes (`ftp:`, `mailto:`), and URLs containing spaces or quotes are not masked or are cut at the first excluded character. A URL ending in a balanced bracket plus real punctuation follows the same trimming heuristic as citations. Existing stored mentions are not recomputed. Offsets still refer to the NFC-normalized text.
- **Tests changed:** no existing assertion depended on matches inside URLs (the mock answer's forced mentions are in prose), so no previous expectations were altered. New file `tests/unit/brandMatcherUrls.test.ts`.

### New environment variables (all in `.env.example`, placeholders only)
`PROVIDER_MODE`, `ALLOW_MOCK_IN_PRODUCTION`, `ENABLE_MOCK_FAILURE_INJECTION`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX_PER_TENANT`, `RATE_LIMIT_MAX_UNAUTH_PER_IP`, `MAX_INFLIGHT_WAITS_PER_TENANT`, `MAX_INFLIGHT_WAITS_GLOBAL`, `BODY_LIMIT_BYTES`, `MAX_QUESTION_CHARS`, `MAX_TARGETS_PER_REQUEST`, `MAX_BRANDS`, `MAX_ALIASES_PER_BRAND`, `MAX_TOTAL_ALIASES`.

### Behaviour changes callers should know
- Brand ids derived from names changed from ASCII slugs to `b_<hash>`; clients that relied on slug ids must send explicit `brandId`s.
- Stored brand order is the input order; ties between equal-length overlapping matches still resolve by brand order.
- Aliases shorter than 2 characters and more than the limits are now `400`.
- The sync wait default poll interval is 100 ms (was 50 ms).

## Accepted backlog (deliberately NOT implemented)

- **M3 - controlled replay of failed requests** (operator-triggered re-run of `failed` rows / DLQ entries with audit trail).
- **Advanced matcher optimization** (e.g. Aho-Corasick over all terms in one pass instead of one regex per term).
- **L2** duplicate-key handling beyond what M2 requires (key rotation, per-key metadata).
- **L4** graceful shutdown (drain in-flight jobs), `unhandledRejection` handling, metrics export.
- **L6** `attemptsMade` is not preserved across stalled redeliveries or replacement jobs, so a stalled job can get more provider attempts than `MAX_ATTEMPTS` in total.

## Known limitations / remaining risks

- **Revisit before production:** rate limits and in-flight caps are per-process (see M4). Behind a proxy, configure trust-proxy.
- **Revisit before production:** a `queued` row whose job vanished (failed/removed in Redis) is not re-enqueued under a new epoch; only stale `running` rows are. A reconciler should cover both.
- A zombie delivery whose lock was lost but is still executing may make one extra provider call (cost) before being fenced at the ledger; data stays correct.
- `staleRunningMs` (2 x lock) is only the threshold after which a `running` row MAY be taken over by a same-day `submit()` or a returning delayed delivery; it is not a bound on how long a row stays stranded. Nothing heals a row on its own (no background reconciler), and a resubmission after UTC midnight creates a new row without healing the old one. See "Accepted limitations - Milestone 1".
- DLQ recovery depends on a worker process running the sweep.
- Real provider adapters, cost tracking, API cost monitoring and key management remain out of scope; `PROVIDER_MODE=real` intentionally cannot start yet.
- Brands for a tenant can only be seeded through the repository (or supplied inline per request); no brand CRUD API in M1.
- No cost tracking beyond token usage stored on the answer.
- Windows: run Vitest from a shell with an uppercase drive letter (see `vitest.config.ts`).

## Accepted limitations - Milestone 1

**Milestone 1 is NOT production-ready.** The items below are known and accepted for now; each is a *revisit before production* item.

a. **Stranded rows persist indefinitely (no reconciler).** A `running` or `queued` ledger row can stay in that state forever when: the job exceeded BullMQ's max stalled count; the failure handler kept throwing (e.g. Mongo down) until attempts ran out; or a job left in BullMQ's failed set blocks re-adding the same jobId. Only a same-day resubmission (`submit()`) can take such a row over, and only `running` rows. After UTC midnight a resubmission creates a **new** row (`runDate` is part of the idempotency key) and never heals the old one. Nothing scans for these rows.
b. **Mock providers only.** `PROVIDER_MODE=real` refuses to start because no real adapters exist.
c. **Static API keys from env.** No rotation, scopes or per-key limits.
d. **Rate limits and in-flight caps are per process.** N instances give N times the configured limit; restarts reset them. There is no `TRUST_PROXY` setting, so behind a proxy `req.ip` is the proxy address (affects the per-IP failed-auth limiter).
e. **No separate quota on `questionVersion`.** A client can bump it to force fresh provider calls (new idempotency key); the only bound is the per-tenant rate limit.
f. **Extra provider calls are possible.** Stalled/zombie jobs and replacement jobs across enqueue epochs can call the provider again; total attempts are not strictly bounded by `MAX_ATTEMPTS` (see L6).
g. **Answer vs mentions/citations can disagree after a retry with a non-deterministic provider.** The answer is first-writer-wins while mentions/citations are last-writer-wins. Harmless with the deterministic mocks; **must be fixed before real adapters**.
h. **`NODE_ENV` is now required, and Milestone 1 is NOT production-ready.** `NODE_ENV` has no default and must be exactly `development`, `test` or `production`; `server.ts` and `worker.ts` exit 1 at startup (before any connection) otherwise. Previously a missing value silently meant `development`, which would have skipped the production-only guards. The message names the variable and allowed values and does not echo the supplied value. Vitest sets `NODE_ENV=test` (`vitest.config.ts`). Production-only guards are unchanged. Together with items a-g, this milestone is a development baseline, not a deployable system.

### Test infrastructure: REQUIRE_REDIS
Redis-backed integration suites skip with a console warning when Redis is unreachable (convenient locally). With `REQUIRE_REDIS=true` they fail with a clear error instead. `npm run test:ci` runs Vitest with `vitest.ci.config.ts`, which sets the flag (no extra dependency, works on Windows). Values other than `true`/`false` are an error. `TEST_REDIS_URL` overrides the Redis URL used by tests. Use `test:ci` in CI so a missing Redis can never produce a green run.

### Should fix before / at the start of Milestone 2 (in order)
1. Reconciler for stranded `running`/`queued` rows, plus an explicit `maxStalledCount` on the workers.
2. Reuse the stored answer on retry and fence mention/citation writes (resolves limitation g).
3. `TRUST_PROXY` setting, a re-entrancy guard on the dead-letter sweep, and clearing the sweep timer on shutdown.
