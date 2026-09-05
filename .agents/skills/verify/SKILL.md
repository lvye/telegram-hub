---
name: verify
description: Verify Telegram Hub changes or diagnose its local ingestion, queue, D1, and health flows using focused tests and isolated integration checks. Use for this repository's verification tasks; use ordinary document checks for prose-only edits.
---

# Verify Telegram Hub

Use the repository's existing workerd tests to establish the requested behavior. Read [AGENTS.md](../../../AGENTS.md) for shared contracts, commands and deployment scope. Choose checks from the actual change; the table is a lookup, not a checklist to run in full.

## Choose evidence

Run selected files with `npm test -- test/<name>.test.ts`; multiple files are supported. Add the applicable static checks from AGENTS.md. For a failure, reproduce with the relevant existing test and add regression coverage only when it demonstrates missing behavior.

| Change or symptom | Relevant tests under `test/` |
| --- | --- |
| Event routing, cadence, queue ack/retry/DLQ | `worker.test.ts`, `scheduled.test.ts`, `ingestion-queue.test.ts`, `queue.test.ts` |
| Identity, checkpoint, lease or compaction | `ingestion-service.test.ts`, `delivery-repository.test.ts`, `source-runtime-state-repository.test.ts`, `scheduled.test.ts` |
| Catalog, config or provider | `config.test.ts`, `source-catalog.test.ts`, and the affected `twitterapi-io.test.ts`, `twitterapi-io-search.test.ts`, `x-official.test.ts` or `nitter.test.ts` |
| Feed parsing or Telegram HTML | `xml-parser.test.ts`, `feed-parser-regression.test.ts`, `telegram-html-serializer.test.ts`, `telegram-formatter.test.ts` |
| Schema/index changes | `schema.test.ts` (`npm run db:schema:check`) and affected repository tests |
| Health/readiness | `worker.test.ts`, `readiness.test.ts`; add `npm run test:smoke` for smoke-script changes |

The existing native queue cases in `ingestion-queue.test.ts` cover ingestion through delivery reaching `sent`, immediate dispatch, checkpoint persistence and conditional HTTP 304. `queue.test.ts` also exercises the producer-to-consumer binding. Reuse these instead of rebuilding the chain manually for routine changes.

## Test environment

- `vitest.config.ts` provides test D1 databases, queues and fake bindings. `test/setup.ts` applies migrations and rejects unexpected global `fetch` calls. These tests do not require the user's `.dev.vars`.
- Reuse `test/d1-fixtures.ts` for topology setup/reset. Native queue consumers have separate request contexts: construct each mocked `Response` inside the fetch implementation.
- Use `createScheduledController` with an explicit `cron` and `scheduledTime`, following `scheduled.test.ts`, to cover boundary minutes. Do not wait for real time to reach a maintenance stage.
- `npm run test:smoke` uses injected fetch responses. Running `scripts/smoke-health.mjs` directly probes the supplied live URL and requires its expected version tag; it is not a substitute for local tests.

## When manual local integration adds evidence

Use Wrangler development only for requested manual reproduction or a runtime/configuration issue the existing tests cannot establish. Before executing Wrangler commands, consult the installed version's help and applicable Wrangler skill if available.

- Use a scratch project/configuration with only fake credentials and task-owned state. Leave the user's `.dev.vars` and `.wrangler` state untouched; do not copy real secrets into a backup or temporary project. Exclude inherited credential environment variables too: a separate env file alone does not isolate the process environment.
- Keep D1 commands local and point every stateful command at the same scratch persistence directory. Seed only synthetic topology from the current schema/fixtures; runtime source IDs are connector keys.
- Verify outbound isolation before triggering ingestion. Local mode and fake Telegram tokens do not disable external HTTP. Use controlled upstream responses and an interceptable Telegram transport; if that transport cannot be isolated in the manual setup, use the native queue tests for delivery evidence.
- Read `wrangler.jsonc` for bindings and secret declarations. Optional bindings can be filtered by Wrangler's `secrets.required`/`vars` configuration; check the installed behavior and declare needed fake bindings in the scratch configuration.
- Check `/health` for liveness and `/health/ready` for seeded-source readiness; test bearer authorization when `READINESS_TOKEN` is configured. Stop task-owned servers and retain only useful diagnostic evidence after the check.

Assert persisted outcomes and observed requests. A Telegram 401/dead delivery proves a failure path, not successful delivery; logs or a fixed elapsed time alone do not prove the chain completed.

## Finish

Report checks run, observed behavior, and any verification limitation. After relevant checks pass, stop; use the full `npm run check` gate for cross-cutting or requested CI/release validation. On environment failure, report the exact blocker and complete independent checks rather than weakening assertions or retrying unchanged commands indefinitely.
