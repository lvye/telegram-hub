import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { afterEach, beforeEach, vi } from 'vitest';

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
await applyD1Migrations(env.DB_V2, env.TEST_V2_MIGRATIONS);

beforeEach(() => {
	vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
		const request = new Request(input, init);
		throw new Error(`Unexpected outbound fetch: ${request.method} ${new URL(request.url).hostname}`);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
});
