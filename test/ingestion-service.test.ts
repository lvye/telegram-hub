import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config';
import type {
	CanonicalItem,
	IngestionBatch,
	SourceAdapter,
	SourceDefinition,
} from '../src/domain/ingestion';
import { IngestionService } from '../src/ingestion/ingestion-service';
import { SourceAdapterRegistry } from '../src/ingestion/source-adapter-registry';
import { DeliveryRepository } from '../src/persistence/delivery-repository';
import { resetDatabase, seedDefaultTopology } from './d1-fixtures';

const NOW = 1_783_760_000;
const SOURCE: SourceDefinition = {
	sourceId: 'rss:it_home',
	adapterKey: 'fake',
	identityNamespace: 'rss:it-home',
	destinationKey: 'telegram:IT_HOME',
	pollEveryMinutes: 1,
	config: {},
};
const OPTIONS = getConfig(env).ingestion;

describe('IngestionService', () => {
	const repository = new DeliveryRepository(env.DB);

	beforeEach(async () => {
		await resetDatabase(env.DB);
		await seedDefaultTopology(env.DB, getConfig(env), NOW);
	});

	it('drains unseen items across bounded ingestion windows', async () => {
		const service = serviceFor({
			items: [item('newest', 3), item('middle', 2), item('oldest', 1)],
			itemLimit: 2,
			checkpoint: null,
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW, 'run-1'))
			.resolves.toMatchObject({ discovered: 2 });
		await expect(service.ingest(SOURCE, OPTIONS, NOW + 60, 'run-2'))
			.resolves.toMatchObject({ discovered: 1 });
		const rows = await env.DB.prepare(`
			SELECT canonical_id FROM content_items ORDER BY published_at
		`).all<{ canonical_id: string }>();
		expect(rows.results.map(({ canonical_id }) => canonical_id))
			.toEqual(['oldest', 'middle', 'newest']);
	});

	it('deduplicates aliases within a provider batch before writing', async () => {
		const service = serviceFor({
			items: [
				{ ...item('provider-guid', 1), identityAliases: ['shared-id'] },
				{ ...item('canonical-id', 2), identityAliases: ['shared-id'] },
			],
			itemLimit: 50,
			checkpoint: null,
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW, 'run'))
			.resolves.toMatchObject({ discovered: 1 });
		const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM content_items').first();
		expect(count).toEqual({ count: 1 });
	});

	it('rejects oversized candidate batches before content persistence', async () => {
		const commit = vi.fn(async () => undefined);
		const service = serviceFor({
			items: Array.from({ length: 501 }, (_, index) => item(`candidate-${index}`, index)),
			itemLimit: 50,
			checkpoint: { commit },
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW, 'run'))
			.rejects.toThrow('returned 501 candidates; limit is 500');
		expect(commit).not.toHaveBeenCalled();
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items) AS items,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries
		`).first();
		expect(counts).toEqual({ items: 0, deliveries: 0 });
	});

	it('drains a checkpoint batch before advancing its checkpoint', async () => {
		const commit = vi.fn(async () => undefined);
		const service = serviceFor({
			items: Array.from({ length: 120 }, (_, index) => item(`candidate-${index}`, index)),
			itemLimit: 50,
			checkpoint: { commit },
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW, 'run-1'))
			.resolves.toMatchObject({ discovered: 50 });
		expect(commit).not.toHaveBeenCalled();
		await expect(persistedCounts()).resolves.toEqual({ items: 50, deliveries: 50 });
		await expect(service.ingest(SOURCE, OPTIONS, NOW + 60, 'run-2'))
			.resolves.toMatchObject({ discovered: 50 });
		expect(commit).not.toHaveBeenCalled();
		await expect(persistedCounts()).resolves.toEqual({ items: 100, deliveries: 100 });
		await expect(service.ingest(SOURCE, OPTIONS, NOW + 120, 'run-3'))
			.resolves.toMatchObject({ discovered: 20 });
		expect(commit).toHaveBeenCalledWith(NOW + 120);
		await expect(persistedCounts()).resolves.toEqual({ items: 120, deliveries: 120 });
	});

	it('routes every known checkpoint candidate before advancing the checkpoint', async () => {
		const candidates = Array.from(
			{ length: 120 },
			(_, index) => item(`known-${index}`, index),
		);
		await repository.upsertItems(
			SOURCE.identityNamespace,
			'telegram:TWITTER',
			candidates,
			NOW,
		);
		const commit = vi.fn(async () => undefined);
		const service = serviceFor({
			items: candidates,
			itemLimit: 50,
			checkpoint: { commit },
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW + 60, 'run'))
			.resolves.toMatchObject({ discovered: 0 });
		expect(commit).toHaveBeenCalledWith(NOW + 60);
		const count = await env.DB.prepare(`
			SELECT COUNT(*) AS count
			FROM message_deliveries AS deliveries
			JOIN destinations ON destinations.id = deliveries.destination_id
			WHERE destinations.destination_key = 'telegram:it-home'
		`).first();
		expect(count).toEqual({ count: 120 });
	});

	it('rejects identity alias expansion beyond the D1 query budget', async () => {
		const candidate = {
			...item('alias-heavy', 1),
			identityAliases: Array.from({ length: 1_000 }, (_, index) => `alias:${index}`),
		};
		const service = serviceFor({
			items: [candidate],
			itemLimit: 50,
			checkpoint: null,
			telemetry: { provider: 'fake' },
		});

		await expect(service.ingest(SOURCE, OPTIONS, NOW, 'run'))
			.rejects.toThrow('returned 1001 identity aliases; limit is 1000');
	});

	it('commits a checkpoint only after content and delivery persistence', async () => {
		const commit = vi.fn(async () => {
			const counts = await env.DB.prepare(`
				SELECT
					(SELECT COUNT(*) FROM content_items) AS items,
					(SELECT COUNT(*) FROM message_deliveries) AS deliveries
			`).first();
			expect(counts).toEqual({ items: 1, deliveries: 1 });
		});
		const service = serviceFor({
			items: [item('checkpointed', 1)],
			itemLimit: 50,
			checkpoint: { commit },
			telemetry: { provider: 'fake' },
		});

		await service.ingest(SOURCE, OPTIONS, NOW, 'run');
		expect(commit).toHaveBeenCalledWith(NOW);
	});

	it.each<[number, string]>([
		[0, 'itemLimit must be a positive integer'],
		[51, 'itemLimit 51 exceeds configured maximum 50'],
	])('rejects an adapter itemLimit of %i without persisting content', async (itemLimit, message) => {
		const invalid: IngestionBatch = {
			items: [item('invalid', 1)],
			itemLimit,
			checkpoint: null,
			telemetry: { provider: 'fake' },
		};

		await expect(serviceFor(invalid).ingest(SOURCE, OPTIONS, NOW, 'run'))
			.rejects.toThrow(message);
		const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM content_items').first();
		expect(count).toEqual({ count: 0 });
	});

	function serviceFor(batch: IngestionBatch): IngestionService {
		const adapter: SourceAdapter<Record<string, never>> = {
			key: 'fake',
			decodeConfig: () => ({}),
			load: async () => batch,
		};
		return new IngestionService(
			repository,
			new SourceAdapterRegistry().register(adapter),
		);
	}

	async function persistedCounts(): Promise<{ items: number; deliveries: number }> {
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM content_items) AS items,
				(SELECT COUNT(*) FROM message_deliveries) AS deliveries
		`).first<{ items: number; deliveries: number }>();
		if (!counts) throw new Error('Missing persistence counts');
		return counts;
	}
});

function item(externalId: string, publishedAt: number): CanonicalItem {
	return {
		externalId,
		title: externalId,
		description: null,
		link: `https://example.com/${externalId}`,
		author: null,
		imageUrl: null,
		publishedAt,
	};
}
