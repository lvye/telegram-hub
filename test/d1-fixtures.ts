import type { AppConfig } from '../src/config';
import { normalizeDestinationKey } from '../src/config';
import { RSS_SOURCE_ADAPTER_KEY } from '../src/ingestion/rss-source-adapter';

export async function resetDatabase(db: D1Database): Promise<void> {
	await db.batch([
		db.prepare('DELETE FROM message_deliveries'),
		db.prepare('DELETE FROM item_observations'),
		db.prepare('DELETE FROM item_identities'),
		db.prepare('DELETE FROM content_items'),
		db.prepare('DELETE FROM source_connector_checkpoints'),
		db.prepare('DELETE FROM source_connector_state'),
		db.prepare('DELETE FROM source_routes'),
		db.prepare('DELETE FROM source_connectors'),
		db.prepare('DELETE FROM destinations'),
		db.prepare('DELETE FROM sources'),
	]);
}

export async function seedDefaultTopology(
	db: D1Database,
	config: AppConfig,
	now: number,
): Promise<void> {
	for (const destination of config.destinations) {
		await db.prepare(`
			INSERT INTO destinations (
				destination_key, provider_key, adapter_key, status,
				config_json, created_at, updated_at
			) VALUES (?, 'telegram', 'telegram.bot', 'active', '{}', ?, ?)
		`).bind(normalizeDestinationKey(destination.destinationKey), now, now).run();
	}

	for (const source of DEFAULT_RSS_SOURCES) {
		const sourceKey = `rss:${slug(source.sourceKey)}`;
		await db.prepare(`
			INSERT INTO sources (
				source_key, source_type, identity_namespace, display_name,
				status, settings_json, created_at, updated_at
			) VALUES (?, 'rss_feed', ?, ?, 'active', '{}', ?, ?)
		`).bind(sourceKey, source.identityNamespace, source.sourceKey, now, now).run();
		await db.prepare(`
			INSERT INTO source_connectors (
				source_id, connector_key, provider_key, adapter_key, status,
				poll_interval_seconds, config_json, created_at, updated_at
			)
			SELECT id, ?, 'rss', ?, 'active', ?, ?, ?, ?
			FROM sources WHERE source_key = ?
		`).bind(
			`rss:${source.sourceKey.toLowerCase()}`,
			RSS_SOURCE_ADAPTER_KEY,
			source.pollEveryMinutes * 60,
			JSON.stringify({
				identityStrategy: source.identityStrategy,
				parser: source.parser,
				url: source.url,
			}),
			now,
			now,
			sourceKey,
		).run();
		await db.prepare(`
			INSERT INTO source_routes (source_id, destination_id, status, created_at, updated_at)
			SELECT sources.id, destinations.id, 'active', ?, ?
			FROM sources, destinations
			WHERE sources.source_key = ? AND destinations.destination_key = ?
		`).bind(
			now,
			now,
			sourceKey,
			normalizeDestinationKey(source.destinationKey),
		).run();
	}
}

const DEFAULT_RSS_SOURCES = [
	{
		sourceKey: 'IT_HOME',
		identityNamespace: 'rss:it-home',
		destinationKey: 'telegram:IT_HOME',
		pollEveryMinutes: 1,
		url: 'https://www.ithome.com/rss/',
		parser: 'it-home',
		identityStrategy: 'external-id',
	},
	{
		sourceKey: 'TWITTER',
		identityNamespace: 'twitter:status',
		destinationKey: 'telegram:TWITTER',
		pollEveryMinutes: 1,
		url: 'https://example.com/twitter.xml',
		parser: 'twitter',
		identityStrategy: 'twitter-status-url',
	},
] as const;

export async function seedDestination(
	db: D1Database,
	destinationKey: string,
	now: number,
): Promise<void> {
	await db.prepare(`
		INSERT INTO destinations (
			destination_key, provider_key, adapter_key, status,
			config_json, created_at, updated_at
		) VALUES (?, 'telegram', 'telegram.bot', 'active', '{}', ?, ?)
	`).bind(normalizeDestinationKey(destinationKey), now, now).run();
}

function slug(value: string): string {
	return value.toLowerCase().replaceAll('_', '-');
}
