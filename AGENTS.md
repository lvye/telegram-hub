# AGENTS.md

Repository guidance for Telegram Hub, a TypeScript ES module Worker on Cloudflare.

## Working agreement

- Carry the user's request through implementation and relevant verification. Resolve routine choices from the code and session context; ask only when missing information materially affects correctness or an action lacks authorization.
- User instructions take precedence over repository and skill guidance, within system/developer instructions and tool permissions. Reuse authorization already given. If a skill blocks work, identify its file and exact instruction, explain the blocker, and finish independent work.
- Read affected code and tests before changing behavior. Batch independent reads; delegate bounded, independent work when tools are available and it improves speed or review quality. Avoid overlapping edits.
- Load skills when their scope matches the task. For verification selection or local integration diagnostics, use [verify](.agents/skills/verify/SKILL.md). Do not load every installed skill or copy their manuals here.
- Keep changes focused and preserve user work. Report the outcome, checks actually run, and blockers concisely in the user's language. Stop after the requested result and relevant checks are complete; expand verification only for new evidence or unresolved risk.

## Code map

| Area | Entry points and responsibility |
| --- | --- |
| Runtime | `src/worker.ts`: scheduled/queue handlers and GET `/health`, `/health/ready`. Keep its sole default export; ordinary helper exports break this entry module in workerd. |
| Scheduling | `src/scheduling.ts`, `src/config.ts`, `wrangler.jsonc`: exact Cron expressions, stage cadence, queue names, bindings and limits. Keep these aligned. |
| Ingestion | `src/ingestion/`: D1-backed catalog, adapter registry, RSS/Nitter/TwitterAPI.io/X adapters, queue dispatch and consumption. `ingestion-service.ts` persists canonical items and commits checkpoints; it does not send Telegram messages. |
| Persistence | `src/persistence/delivery-repository.ts`: content, identities, deliveries and checkpoints. `source-runtime-state-repository.ts`: source queue claims, execution leases and recovery. |
| Delivery | `src/delivery/`: dispatch IDs, lease deliveries, format/revalidate Telegram HTML and send messages. Feed interpretation belongs in `src/parsers/`. |
| Storage and health | `migrations/`: schema history. `src/maintenance/cleanup.ts`: content compaction/recovery. `src/health/readiness.ts`: source readiness. |
| Verification | `test/`, `vitest.config.ts`, `scripts/smoke-health.node.mjs`; CI and deployment order live in `.github/workflows/deploy.yml`. |

## Contracts to preserve

- Item identity is `(identity_namespace, canonical_id)` plus aliases; delivery identity is `(item_id, destination_id)`. Repeated observations must not resurrect compacted content or reset terminal deliveries; known items can still need routing to new destinations.
- Runtime `SourceDefinition.sourceId` is the connector's `connector_key`, distinct from `sources.source_key`. Provider switches preserve logical identity and aliases, bootstrap from known identity, and retain resumable pagination. Keep provider logic in adapters/catalog, not conditionals in `IngestionService`; chat IDs and formatting belong to destinations.
- Persist content and required deliveries before committing a batch checkpoint, including RSS ETag/Last-Modified validators. Keep feed bytes, candidates, aliases, writes and API pagination bounded by configured budgets; preserve indexed D1 hot paths.
- Cron schedules ingestion jobs; queue consumers fetch sources. Dispatch new deliveries immediately after successful ingestion. The five-minute sweep drains pending deliveries; stale delivery lease recovery runs through cleanup.
- Queues are at-least-once. Preserve source queue tokens across retries, acquire execution/delivery leases, and condition completion on the same lease token. Stale jobs and DLQ copies must not clear newer leases. Respect retry eligibility (`next_attempt_at` in D1) and lease expiry; use queue delays rather than sleeping inside a Worker invocation.
- Treat upstream content as untrusted. Preserve URL validation, HTML escaping, rich-text revalidation and Telegram message limits.
- Add numbered migrations instead of rewriting applied history; update schema/index coverage. Production source/account rows are operational data, not committed seed SQL. Destructive schema changes need a verified backup and a rollout compatible with the running Worker.

## Commands and validation

Use npm and the committed lockfile. CI uses Node.js 22. `package.json` owns commands; `.prettierrc` defines formatting (tabs, single quotes, semicolons), and TypeScript is strict.

| Need | Command |
| --- | --- |
| Install dependencies | `npm ci` |
| TypeScript / Worker floating promises | `npm run ts:check` / `npm run lint` |
| Focused workerd tests | `npm test -- test/<file>.test.ts` (accepts multiple files) |
| All workerd tests / local smoke-script tests | `npm test` / `npm run test:smoke` |
| Validate / regenerate binding types | `npm run cf:types:check` / `npm run cf:types:generate` |
| Validate bundle without deployment | `npm run deploy:dry` |
| Full CI gate | `npm run check` (binding type check → TypeScript → lint → workerd tests → smoke-script tests → dry bundle) |

- Documentation-only edits need link/path/command consistency and `git diff --check`, not the runtime suite. Behavior changes need focused regression coverage plus applicable static checks. Broaden to `npm run check` for cross-cutting changes or requested CI/release validation.
- Regenerate `worker-configuration.d.ts` when bindings/configuration require it; do not edit generated declarations manually. `npm run check` checks types without regenerating them.
- Tests use isolated D1/Queues with fake bindings from `vitest.config.ts`; `test/setup.ts` applies migrations and rejects unexpected global `fetch` calls. For native queue tests, construct mocked `Response` objects inside the fetch implementation because consumers run in separate request contexts.
- Local development can call real external services. Preserve `.dev.vars` and existing `.wrangler` state; use the verify skill's isolation guidance before starting `npm run dev` for integration checks.

## Deployment boundaries

`npm run db:migrate:local` changes local D1. `npm run db:migrate:remote` and `npm run deploy` change production. Use them within the user's authorized scope; routine verification uses isolated tests and the dry bundle. Prepare reviewable changes before any still-needed approval.

CI verifies pull requests. A push to `main` triggers remote migrations, strict SHA-tagged deployment, then `scripts/smoke-health.mjs` against the deployed Worker. That script makes real HTTP requests; `npm run test:smoke` tests it locally with injected fetch responses. Keep secrets and real database IDs out of commits and logs.

## Maintaining these instructions

Keep project facts here and task-specific verification detail in the skill; `CLAUDE.md` references this file. Update guidance when its owning code changes, rather than retaining historical workarounds, fixed query counts or copied provider manuals.

Sources: [OpenAI model prompting](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices), [AGENTS.md discovery](https://learn.chatgpt.com/docs/agent-configuration/agents-md), [skill scope and discovery](https://learn.chatgpt.com/docs/build-skills).
