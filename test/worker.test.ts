import { describe, expect, it } from 'vitest';
import {
	CLEANUP_CRON,
	scheduledTaskFor,
	shouldSweepDeliveries,
	sourceMaintenanceStagesFor,
	UPDATE_CRON,
} from '../src/scheduling';
import worker from '../src/worker';

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

	it('spreads source maintenance across 15-minute boundaries', () => {
		expect(stagesAt('04:00')).toEqual([]);
		expect(stagesAt('04:01')).toEqual(['source_sync']);
		expect(stagesAt('04:06')).toEqual(['source_recovery']);
		expect(stagesAt('04:11')).toEqual(['readiness']);
		expect(stagesAt('04:16')).toEqual(['source_sync']);
	});

	it('sweeps ready deliveries only on five-minute boundaries', () => {
		expect(shouldSweepDeliveries(Date.parse('2026-07-10T04:00:00Z'))).toBe(true);
		expect(shouldSweepDeliveries(Date.parse('2026-07-10T04:01:00Z'))).toBe(false);
		expect(shouldSweepDeliveries(Date.parse('2026-07-10T04:04:00Z'))).toBe(false);
		expect(shouldSweepDeliveries(Date.parse('2026-07-10T04:05:00Z'))).toBe(true);
		expect(shouldSweepDeliveries(Date.parse('2026-07-10T04:55:00Z'))).toBe(true);
	});
});

function stagesAt(time: string) {
	return sourceMaintenanceStagesFor(Date.parse(`2026-07-10T${time}:00Z`));
}

function healthEnv(): Env {
	return {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
	} as Env;
}
