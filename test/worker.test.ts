import { describe, expect, it } from 'vitest';
import worker, { CLEANUP_CRON, scheduledTaskFor, UPDATE_CRON } from '../src/worker';

describe('worker', () => {
	it('serves a read-only health endpoint', async () => {
		const response = await worker.fetch(new Request('https://example.com/health'));

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			service: 'telegram-hub',
			status: 'ok',
		});
	});

	it('does not expose the old mutation endpoint', async () => {
		const response = await worker.fetch(new Request('https://example.com/test'));

		expect(response.status).toBe(404);
	});

	it('routes cron triggers by their exact expression', () => {
		expect(scheduledTaskFor(UPDATE_CRON)).toBe('update');
		expect(scheduledTaskFor(CLEANUP_CRON)).toBe('cleanup');
		expect(() => scheduledTaskFor('15 * * * *')).toThrow('Unsupported cron trigger');
	});
});
