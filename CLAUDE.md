# CLAUDE.md

Guidance for coding agents working in this repository.

## Project overview

Telegram Hub is a TypeScript ES Module Worker. Scheduled events ingest RSS feeds, D1 stores item identity and a per-destination delivery state machine, and Cloudflare Queues delivers messages to Telegram asynchronously.

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
- `src/ingestion/` fetches bounded RSS responses, normalizes feed items, and persists stable identities. It never sends Telegram messages.
- `src/persistence/delivery-repository.ts` owns all D1 state transitions and leases.
- `src/delivery/dispatcher.ts` publishes delivery IDs; `consumer.ts` acquires a lease and calls the Telegram adapter.
- `src/parsers/` returns normalized feed data. Telegram HTML belongs in `src/delivery/telegram-formatter.ts`.
- `migrations/` is the only source of truth for database schema.

## Delivery invariants

- Item identity is `(source_key, external_id)`; delivery identity is `(item_id, destination_key)`.
- Ingestion treats a known identity as immutable. It scans the byte-bounded feed, queries known IDs once, and writes at most 50 unseen items per source so compaction stays compacted and delayed items can drain across runs.
- Queue delivery is at-least-once. A consumer must acquire a D1 lease before calling Telegram and must make terminal transitions conditional on that lease token.
- Respect both `available_at` and `lease_expires_at`; duplicate jobs must not bypass backoff or steal an active lease.
- Retryable Telegram failures are rescheduled with Queue delay. Permanent failures become `dead`. Cloudflare's native DLQ handles infrastructure failures; its consumer preserves active leases and returns non-exhausted work to D1 `retry`.
- Do not add sleep-based retries inside a Worker invocation.
- Keep D1 query counts within the Workers Free per-invocation budget. A 10-message Queue batch currently uses at most 40 queries on the success path.

## Migration and rollback

Migration `0003` is additive. During the observation window, ingestion incrementally reconciles late legacy rows using `migration_bridge_state`, successful sends update the legacy `pushed_items` sent ledger, and daily cleanup bounds the old table. Preserve this bridge until rollback to the old Worker is no longer required; remove it and the old table only in a later migration.

The rollback bridge inherits the old table's globally unique GUID limitation. Do not introduce cross-source GUID collisions during the observation period. A near-zero-duplicate production cutover also requires pausing old triggers and waiting for in-flight invocations; code alone cannot eliminate overlap between an already-running old invocation and the new deployment.

## Style and tests

- Tabs, single quotes, semicolons, strict TypeScript.
- Keep network I/O in adapters and orchestration in event handlers.
- Add workerd tests for state transitions, exact Cron routing, Queue retry/ack behavior, migration compatibility, and HTML escaping.
- Native Queue integration tests run consumers in a separate request context; create mocked `Response` objects inside the fetch mock implementation, not ahead of time.
