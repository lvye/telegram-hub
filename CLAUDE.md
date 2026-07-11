# CLAUDE.md

Guidance for coding agents working in this repository.

## Project overview

Telegram Hub is a TypeScript ES Module Worker. Scheduled events ingest RSS feeds or TwitterAPI.io, D1 stores item identity and a per-destination delivery state machine, and Cloudflare Queues delivers messages to Telegram asynchronously.

## Commands

```bash
npm ci
npm run types       # regenerate worker-configuration.d.ts
npm run typecheck
npm test            # Vitest in the Cloudflare workerd pool
npm run deploy:dry
npm run check       # generated types + TypeScript + tests + dry-run bundle
npm run dev
```

Apply D1 migrations explicitly before deployment:

```bash
npx wrangler d1 migrations apply rss --local
npx wrangler d1 migrations apply rss --remote
```

## Architecture

- `src/worker.ts` is the only runtime entry point. It routes exact Cron expressions, Queue names, and the read-only health endpoint.
- `src/ingestion/` contains the Source Catalog, adapter registry, provider adapters, and provider-neutral ingestion service. Adapters emit `CanonicalItem`; the service owns identity lookup, persistence, and checkpoint commits. Twitter provider changes must preserve RSS GUID aliases, the latest-known-identity handoff high-water, and resumable API pagination. It never sends Telegram messages.
- A runtime source separates `sourceId`, `adapterKey`, identity namespace, destination key, and cadence. Telegram chat IDs and formatting belong to destination configuration, never adapter inputs.
- `source_runtime_state` owns provider-neutral catalog metadata, queue claims, scheduling, execution leases, and failure counters. `source_ingestion_state` owns provider-specific checkpoints. Cron only claims due sources and publishes one job per source; ingestion Queue consumers perform network work.
- `src/persistence/delivery-repository.ts` owns all D1 state transitions and leases.
- `src/delivery/dispatcher.ts` publishes delivery IDs; `consumer.ts` acquires a lease and calls the Telegram adapter.
- `src/parsers/` interprets feed-specific data. Adapters convert parser output to canonical items; final Telegram formatting and rich-text revalidation live in the delivery layer.
- `migrations/` is the only source of truth for database schema.

## Delivery invariants

- Item identity is `(source_key, external_id)`; delivery identity is `(item_id, destination_key)`.
- Adding a provider must only require a `SourceAdapter` registration and Catalog entry. Do not add provider conditionals to `IngestionService`.
- Ingestion treats a known identity as immutable. RSS scans the byte-bounded feed and writes at most 50 unseen items per run; the API adapter uses a bounded page budget plus a durable continuation cursor. Both query known aliases once so compaction stays compacted and delayed items can drain across runs.
- Provider switches must preserve `source_key`, canonicalize provider-specific identity, and bootstrap `source_ingestion_state` from a known identity rather than a wall-clock-only cutover.
- Source execution must acquire a `sourceId` lease and conditionally finish with the same token. A stale invocation must not overwrite a newer attempt's runtime result.
- Ingestion Queue jobs must carry the D1 queue token. Retryable source failures preserve that token while scheduling `Retry-After`/exponential-jitter delay; expired claims and leases are recoverable, and permanent HTTP failures become `blocked`.
- Queue delivery is at-least-once. A consumer must acquire a D1 lease before calling Telegram and must make terminal transitions conditional on that lease token.
- Respect both `available_at` and `lease_expires_at`; duplicate jobs must not bypass backoff or steal an active lease.
- Retryable Telegram failures are rescheduled with Queue delay. Permanent failures become `dead`. Cloudflare's native DLQ handles infrastructure failures; its consumer preserves active leases and returns non-exhausted work to D1 `retry`.
- Do not add sleep-based retries inside a Worker invocation.
- Keep D1 query counts within the Workers Free per-invocation budget. A 10-message Queue batch currently uses at most 40 queries on the success path.

## Migration and rollback

Migration `0003` is additive. During the observation window, ingestion incrementally reconciles late legacy rows using `migration_bridge_state`, successful sends update the legacy `pushed_items` sent ledger, and daily cleanup bounds the old table. Preserve this bridge until rollback to the old Worker is no longer required; remove it and the old table only in a later migration.

Migration `0004` owns provider handoff/pagination state and the indexed identity aliases used to deduplicate RSS/API representations of the same tweet.

The rollback bridge inherits the old table's globally unique GUID limitation. Do not introduce cross-source GUID collisions during the observation period. A near-zero-duplicate production cutover also requires pausing old triggers and waiting for in-flight invocations; code alone cannot eliminate overlap between an already-running old invocation and the new deployment.

## Style and tests

- Tabs, single quotes, semicolons, strict TypeScript.
- Keep network I/O in adapters and orchestration in event handlers.
- Add workerd tests for state transitions, exact Cron routing, Queue retry/ack behavior, migration compatibility, and HTML escaping.
- Native Queue integration tests run consumers in a separate request context; create mocked `Response` objects inside the fetch mock implementation, not ahead of time.
