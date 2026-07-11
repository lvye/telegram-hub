import { env } from 'cloudflare:workers';
import { beforeEach, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { SchemaV2ShadowMirror } from '../src/persistence/schema-v2-shadow';

const NOW = 1_783_760_000;

beforeEach(async () => {
	await env.DB.batch([
		env.DB.prepare('DELETE FROM deliveries'),
		env.DB.prepare('DELETE FROM item_identity_aliases'),
		env.DB.prepare('DELETE FROM items'),
		env.DB.prepare('DELETE FROM source_ingestion_state'),
		env.DB.prepare('DELETE FROM source_runtime_state'),
		env.DB.prepare('DELETE FROM twitter_subscriptions'),
	]);
	await env.DB_V2.batch([
		env.DB_V2.prepare('DELETE FROM message_deliveries'),
		env.DB_V2.prepare('DELETE FROM item_observations'),
		env.DB_V2.prepare('DELETE FROM item_identities'),
		env.DB_V2.prepare('DELETE FROM content_items'),
		env.DB_V2.prepare('DELETE FROM source_connector_checkpoints'),
		env.DB_V2.prepare('DELETE FROM source_connector_state'),
		env.DB_V2.prepare('DELETE FROM source_routes'),
		env.DB_V2.prepare('DELETE FROM source_connectors'),
		env.DB_V2.prepare('DELETE FROM destinations'),
		env.DB_V2.prepare('DELETE FROM sources'),
		env.DB_V2.prepare('DELETE FROM schema_mirror_cursors'),
	]);
});

it('mirrors legacy topology, checkpoint, identity, observation, and delivery idempotently', async () => {
	await env.DB.batch([
		env.DB.prepare(`
			INSERT INTO twitter_subscriptions (
				id, provider_state_key, user_name, status, poll_every_minutes,
				include_replies, max_pages, created_at, updated_at
			) VALUES (1, 'twitterapi-io:subscription:macromargin', 'MacroMargin',
				'active', 5, 0, 1, ?, ?)
		`).bind(NOW - 300, NOW - 300),
		env.DB.prepare(`
			INSERT INTO source_runtime_state (
				source_id, adapter_key, identity_namespace, destination_key,
				poll_every_seconds, status, next_poll_at, consecutive_failures,
				last_attempt_at, last_success_at, created_at, updated_at
			) VALUES ('nitter:subscription:1', 'nitter.user-timeline', 'TWITTER',
				'telegram:TWITTER', 300, 'idle', ?, 0, ?, ?, ?, ?)
		`).bind(NOW + 300, NOW, NOW, NOW - 300, NOW),
		env.DB.prepare(`
			INSERT INTO source_ingestion_state (
				source_key, provider, initialized_at, last_successful_poll_at,
				high_water_external_id, updated_at
			) VALUES ('TWITTER', 'nitter:subscription:1', ?, ?, 'twitter:123', ?)
		`).bind(NOW - 300, NOW, NOW),
		env.DB.prepare(`
			INSERT INTO items (
				id, source_key, external_id, title, link, author, published_at,
				metadata_json, created_at, updated_at
			) VALUES (90001, 'TWITTER', 'twitter:123', 'Tweet',
				'https://x.com/MacroMargin/status/123', 'MacroMargin', ?,
				'{"provider":"nitter"}', ?, ?)
		`).bind(NOW, NOW, NOW),
	]);
	await env.DB.batch([
		env.DB.prepare(`
			INSERT INTO item_identity_aliases (source_key, alias, item_id, created_at)
			VALUES ('TWITTER', 'https://nitter.net/MacroMargin/status/123#m', 90001, ?)
		`).bind(NOW),
		env.DB.prepare(`
			INSERT INTO deliveries (
				id, item_id, destination_key, status, attempt_count, available_at,
				provider_message_id, created_at, updated_at, sent_at
			) VALUES (90001, 90001, 'telegram:TWITTER', 'sent', 1, ?,
				'telegram-123', ?, ?, ?)
		`).bind(NOW, NOW, NOW, NOW),
	]);

	const mirror = new SchemaV2ShadowMirror(env.DB, env.DB_V2, getConfig(workerEnv()));
	await expect(mirror.run()).resolves.toEqual({
		connectors: 1,
		contentItems: 1,
		messageDeliveries: 0,
	});
	await expect(mirror.run()).resolves.toEqual({
		connectors: 1,
		contentItems: 0,
		messageDeliveries: 1,
	});

	const row = await env.DB_V2.prepare(`
		SELECT
			sources.source_key,
			source_connectors.provider_key,
			content_items.identity_namespace,
			item_observations.provider_item_id,
			message_deliveries.state,
			message_deliveries.provider_message_id
		FROM message_deliveries
		JOIN content_items ON content_items.id = message_deliveries.item_id
		JOIN item_observations ON item_observations.item_id = content_items.id
		JOIN source_connectors ON source_connectors.id = item_observations.connector_id
		JOIN sources ON sources.id = source_connectors.source_id
		WHERE message_deliveries.id = 90001
	`).first();
	expect(row).toEqual({
		identity_namespace: 'twitter:status',
		provider_item_id: 'twitter:123',
		provider_key: 'nitter',
		provider_message_id: 'telegram-123',
		source_key: 'twitter:user:macromargin',
		state: 'sent',
	});

	await expect(mirror.run()).resolves.toEqual({
		connectors: 1,
		contentItems: 0,
		messageDeliveries: 0,
	});
	const counts = await env.DB_V2.prepare(`
		SELECT
			(SELECT COUNT(*) FROM content_items) AS items,
			(SELECT COUNT(*) FROM item_observations) AS observations,
			(SELECT COUNT(*) FROM message_deliveries) AS deliveries,
			(SELECT version FROM source_connector_checkpoints LIMIT 1) AS checkpoint_version
	`).first();
	expect(counts).toEqual({
		checkpoint_version: 0,
		deliveries: 1,
		items: 1,
		observations: 1,
	});
});

function workerEnv(): Env {
	return {
		CF_VERSION_METADATA: {
			id: 'test-version-id',
			tag: 'test-version-tag',
			timestamp: '2026-07-11T00:00:00.000Z',
		},
		DB: env.DB,
		DB_V2: env.DB_V2,
		INGESTION_QUEUE: env.INGESTION_QUEUE,
		IT_HOME_CHAT_ID: 'test-it-home-chat',
		NITTER_BASE_URL: 'https://nitter.net/',
		TELEGRAM_BOT_TOKEN: 'test-token',
		TELEGRAM_DELIVERY_QUEUE: env.TELEGRAM_DELIVERY_QUEUE,
		TWITTER_CHAT_ID: 'test-twitter-chat',
		TWITTER_RSS_URL: 'https://example.com/twitter.xml',
		TWITTER_SOURCE_PROVIDER: 'nitter',
	};
}
