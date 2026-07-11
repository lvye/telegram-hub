import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SourceDefinition } from '../src/domain/ingestion';
import {
	nextDueAt,
	SourceRuntimeStateRepository,
} from '../src/persistence/source-runtime-state-repository';

const NOW = Math.floor(Date.parse('2026-07-10T04:11:30Z') / 1_000);

describe('SourceRuntimeStateRepository', () => {
	const repository = new SourceRuntimeStateRepository(env.DB);

	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM source_runtime_state').run();
	});

	it('synchronizes catalog metadata and pauses removed sources', async () => {
		const oneMinute = source('test:one', 1);
		const fiveMinutes = source('test:five', 5);

		await repository.syncSources([oneMinute, fiveMinutes], NOW);
		expect(await repository.get('test:one')).toMatchObject({
			status: 'idle',
			pollEverySeconds: 60,
			nextPollAt: nextDueAt(NOW, 1),
		});
		expect(await repository.get('test:five')).toMatchObject({
			status: 'idle',
			pollEverySeconds: 300,
			nextPollAt: nextDueAt(NOW, 5),
		});

		await repository.syncSources([fiveMinutes], NOW + 60);
		expect(await repository.get('test:one')).toMatchObject({ status: 'paused' });

		await repository.syncSources([oneMinute, fiveMinutes], NOW + 120);
		expect(await repository.get('test:one')).toMatchObject({
			status: 'idle',
			nextPollAt: nextDueAt(NOW + 120, 1),
		});
	});

	it('allows only one active lease and protects completion with its token', async () => {
		await repository.syncSources([source('test:lease', 1)], NOW);

		await expect(repository.acquireLease('test:lease', 'lease-a', NOW, 120)).resolves.toBe(true);
		await expect(repository.acquireLease('test:lease', 'lease-b', NOW + 119, 120)).resolves.toBe(false);
		await expect(repository.acquireLease('test:lease', 'lease-b', NOW + 120, 120)).resolves.toBe(true);
		await expect(repository.markSucceeded('test:lease', 'lease-a', NOW + 180, NOW + 120))
			.resolves.toBe(false);
		await expect(repository.markSucceeded('test:lease', 'lease-b', NOW + 180, NOW + 120))
			.resolves.toBe(true);
		expect(await repository.get('test:lease')).toMatchObject({
			status: 'idle',
			leaseToken: null,
			consecutiveFailures: 0,
			lastSuccessAt: NOW + 120,
			nextPollAt: NOW + 180,
		});
	});

	it('records failures and resets them after a successful attempt', async () => {
		await repository.syncSources([source('test:retry', 1)], NOW);
		await repository.acquireLease('test:retry', 'lease-a', NOW, 120);
		await expect(repository.markFailed(
			'test:retry',
			'lease-a',
			NOW + 60,
			'TEST_FAILURE',
			'provider unavailable',
			NOW,
		)).resolves.toBe(true);
		expect(await repository.get('test:retry')).toMatchObject({
			status: 'backoff',
			consecutiveFailures: 1,
			lastErrorCode: 'TEST_FAILURE',
			lastError: 'provider unavailable',
			nextPollAt: NOW + 60,
		});

		await repository.acquireLease('test:retry', 'lease-b', NOW + 60, 120);
		await repository.markSucceeded('test:retry', 'lease-b', NOW + 120, NOW + 60);
		expect(await repository.get('test:retry')).toMatchObject({
			status: 'idle',
			consecutiveFailures: 0,
			lastErrorCode: null,
			lastError: null,
			lastSuccessAt: NOW + 60,
		});
	});
});

function source(sourceId: string, pollEveryMinutes: number): SourceDefinition {
	return {
		sourceId,
		adapterKey: 'test.fake-v1',
		identityNamespace: 'TEST',
		destinationKey: 'telegram:IT_HOME',
		pollEveryMinutes,
		config: {},
	};
}
