import { describe, expect, it } from 'vitest';
import worker, { CLEANUP_CRON, scheduledTaskFor, UPDATE_CRON } from '../src/worker';

describe('worker', () => {
	it('serves a read-only health endpoint', async () => {
		const response = await worker.fetch(
			new Request('https://example.com/health'),
			healthEnv(),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get('cache-control')).toBe('no-store');
		await expect(response.json()).resolves.toEqual({
			service: 'telegram-hub',
			status: 'ok',
			versionId: 'test-version-id',
			versionTag: 'test-version-tag',
		});
	});

	it('does not expose the old mutation endpoint', async () => {
		const response = await worker.fetch(
			new Request('https://example.com/test'),
			healthEnv(),
		);

		expect(response.status).toBe(404);
	});

	it('routes cron triggers by their exact expression', () => {
		expect(scheduledTaskFor(UPDATE_CRON)).toBe('update');
		expect(scheduledTaskFor(CLEANUP_CRON)).toBe('cleanup');
		expect(() => scheduledTaskFor('15 * * * *')).toThrow('Unsupported cron trigger');
	});
});

function healthEnv(): Env {
	return {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
	} as Env;
}
