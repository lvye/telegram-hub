import { env } from 'cloudflare:workers';
import { applyD1Migrations } from 'cloudflare:test';
import { expect, it } from 'vitest';

await applyD1Migrations(env.SCHEMA_DB, env.TEST_MIGRATIONS);

const EXPECTED_TABLES = [
	'content_items',
	'destinations',
	'item_identities',
	'item_observations',
	'message_deliveries',
	'provider_usage_daily',
	'source_connector_checkpoints',
	'source_connector_state',
	'source_connectors',
	'source_routes',
	'sources',
];

it('creates the normalized schema with enforced identities and state invariants', async () => {
	const tables = await env.SCHEMA_DB.prepare(`
		SELECT name
		FROM sqlite_schema
		WHERE type = 'table'
			AND name NOT LIKE '_cf_%'
			AND name NOT LIKE 'sqlite_%'
			AND name <> 'd1_migrations'
		ORDER BY name
	`).all<{ name: string }>();
	expect(tables.results.map(({ name }) => name)).toEqual(EXPECTED_TABLES);

	const now = 1_783_760_000;
	await env.SCHEMA_DB.batch([
		env.SCHEMA_DB.prepare(`
			INSERT INTO sources (
				id, source_key, source_type, identity_namespace, display_name,
				settings_json, created_at, updated_at
			) VALUES (1, 'twitter:user:macromargin', 'twitter_user', 'twitter:status',
				'MacroMargin', '{"include_replies":false}', ?, ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO source_connectors (
				id, source_id, connector_key, provider_key, adapter_key,
				poll_interval_seconds, config_json, created_at, updated_at
			) VALUES (1, 1, 'twitter:user:macromargin@nitter', 'nitter',
				'nitter.user_timeline', 300, '{"base_url":"https://nitter.net/"}', ?, ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO destinations (
				id, destination_key, provider_key, adapter_key, config_json,
				secret_ref, created_at, updated_at
			) VALUES (1, 'telegram:twitter', 'telegram', 'telegram.bot', '{}',
				'TWITTER_CHAT_ID', ?, ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO source_routes (source_id, destination_id, created_at, updated_at)
			VALUES (1, 1, ?, ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO content_items (
				id, identity_namespace, canonical_id, title, url, published_at,
				created_at, updated_at
			) VALUES (1, 'twitter:status', 'twitter:123', 'Tweet',
				'https://x.com/MacroMargin/status/123', ?, ?, ?)
		`).bind(now, now, now),
	]);

	await env.SCHEMA_DB.batch([
		env.SCHEMA_DB.prepare(`
			INSERT INTO source_connector_state (
				connector_id, state, next_run_at, created_at, updated_at
			) VALUES (1, 'idle', ?, ?, ?)
		`).bind(now, now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO source_connector_checkpoints (
				connector_id, initialized_at, high_water_identity, updated_at
			) VALUES (1, ?, 'twitter:123', ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO item_identities (
				identity_namespace, identity_value, item_id, identity_kind, created_at
			) VALUES ('twitter:status', 'twitter:123', 1, 'canonical', ?)
		`).bind(now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO item_observations (
				connector_id, item_id, provider_item_id, first_observed_at, last_observed_at
			) VALUES (1, 1, '123', ?, ?)
		`).bind(now, now),
		env.SCHEMA_DB.prepare(`
			INSERT INTO message_deliveries (
				id, item_id, destination_id, trigger_source_id, state,
				next_attempt_at, created_at, updated_at
			) VALUES (1, 1, 1, 1, 'pending', ?, ?, ?)
		`).bind(now, now, now),
	]);

	await expect(env.SCHEMA_DB.prepare(`
		INSERT INTO item_identities (
			identity_namespace, identity_value, item_id, identity_kind, created_at
		) VALUES ('twitter:status', 'twitter:123', 1, 'provider_id', ?)
	`).bind(now).run()).rejects.toThrow();

	await expect(env.SCHEMA_DB.prepare(`
		UPDATE source_connector_state
		SET state = 'queued', updated_at = ?
		WHERE connector_id = 1
	`).bind(now).run()).rejects.toThrow();
});

it('uses bounded point lookups and partial indexes for hot paths', async () => {
	await env.SCHEMA_DB.prepare(`
		WITH RECURSIVE sequence(value) AS (
			SELECT 1
			UNION ALL
			SELECT value + 1 FROM sequence WHERE value < 1000
		)
		INSERT INTO content_items (
			identity_namespace, canonical_id, created_at, updated_at
		)
		SELECT 'rss:lookup', 'candidate-' || value, 1783760000, 1783760000
		FROM sequence
	`).run();
	const contentCandidates = JSON.stringify([
		{ externalId: 'candidate-1' },
		{ externalId: 'candidate-1000' },
	]);
	const contentItemPlan = await env.SCHEMA_DB.prepare(`
		EXPLAIN QUERY PLAN
		WITH candidates AS MATERIALIZED (
			SELECT
				CAST(json_extract(candidate.value, '$.externalId') AS TEXT) AS external_id,
				(
					SELECT items.id
					FROM content_items AS items
					WHERE items.identity_namespace = ?
						AND items.canonical_id = CAST(
							json_extract(candidate.value, '$.externalId') AS TEXT
						)
				) AS item_id
			FROM json_each(?) AS candidate
		)
		SELECT external_id, item_id FROM candidates
	`).bind('rss:lookup', contentCandidates).all<{ detail: string }>();
	const contentItemDetails = contentItemPlan.results.map(({ detail }) => detail);
	expect(contentItemDetails.some((detail) => (
		detail.includes('SEARCH items')
		&& detail.includes('identity_namespace=?')
		&& detail.includes('canonical_id=?')
	))).toBe(true);
	expect(contentItemDetails.every((detail) => !detail.includes('SCAN content_items'))).toBe(true);
	const contentItemLookup = await env.SCHEMA_DB.prepare(`
		WITH candidates AS MATERIALIZED (
			SELECT
				CAST(json_extract(candidate.value, '$.externalId') AS TEXT) AS external_id,
				(
					SELECT items.id
					FROM content_items AS items
					WHERE items.identity_namespace = ?
						AND items.canonical_id = CAST(
							json_extract(candidate.value, '$.externalId') AS TEXT
						)
				) AS item_id
			FROM json_each(?) AS candidate
		)
		SELECT external_id, item_id FROM candidates
	`).bind('rss:lookup', contentCandidates).all();
	expect(contentItemLookup.results).toHaveLength(2);
	// The cost scales with the two requested keys, not the 1000-row table cardinality.
	expect(contentItemLookup.meta.rows_read).toBeLessThanOrEqual(6);

	const identityPlan = await env.SCHEMA_DB.prepare(`
		EXPLAIN QUERY PLAN
		SELECT identity_value, item_id
		FROM item_identities
		WHERE identity_namespace = ? AND identity_value IN (?, ?)
	`).bind('twitter:status', 'twitter:123', 'twitter:456').all<{ detail: string }>();
	const identityDetails = identityPlan.results.map(({ detail }) => detail);
	expect(identityDetails.some((detail) => (
		detail.includes('SEARCH item_identities')
		&& detail.includes('identity_namespace=?')
		&& detail.includes('identity_value=?')
	))).toBe(true);
	expect(identityDetails.every((detail) => !detail.includes('SCAN item_identities'))).toBe(true);
	const identityLookup = await env.SCHEMA_DB.prepare(`
		SELECT identity_value, item_id
		FROM item_identities
		WHERE identity_namespace = ? AND identity_value IN (?, ?)
	`).bind('twitter:status', 'twitter:123', 'twitter:missing').all();
	expect(identityLookup.results).toHaveLength(1);
	expect(identityLookup.meta.rows_read).toBeLessThanOrEqual(3);

	const connectorPlan = await env.SCHEMA_DB.prepare(`
		EXPLAIN QUERY PLAN
		SELECT connector_id
		FROM source_connector_state
		WHERE state = 'idle' AND next_run_at <= ?
		ORDER BY next_run_at, connector_id
		LIMIT 100
	`).bind(1_783_760_000).all<{ detail: string }>();
	const connectorDetails = connectorPlan.results.map(({ detail }) => detail);
	expect(connectorDetails.some((detail) => detail.includes('idx_source_connector_state_due'))).toBe(true);
	expect(connectorDetails.every((detail) => !detail.includes('TEMP B-TREE'))).toBe(true);

	const deliveryPlan = await env.SCHEMA_DB.prepare(`
		EXPLAIN QUERY PLAN
		SELECT id
		FROM message_deliveries
		WHERE state = 'pending' AND next_attempt_at <= ?
		ORDER BY next_attempt_at, id
		LIMIT 100
	`).bind(1_783_760_000).all<{ detail: string }>();
	const deliveryDetails = deliveryPlan.results.map(({ detail }) => detail);
	expect(deliveryDetails.some((detail) => detail.includes('idx_message_deliveries_dispatch'))).toBe(true);
	expect(deliveryDetails.every((detail) => !detail.includes('TEMP B-TREE'))).toBe(true);

	const compactionPlan = await env.SCHEMA_DB.prepare(`
		EXPLAIN QUERY PLAN
		UPDATE content_items
		SET
			title = NULL, description = NULL, author_name = NULL,
			image_url = NULL, metadata_json = '{}', updated_at = ?
		WHERE (title IS NOT NULL OR description IS NOT NULL OR image_url IS NOT NULL)
			AND EXISTS (
				SELECT 1
				FROM message_deliveries
				WHERE message_deliveries.item_id = content_items.id
			)
			AND NOT EXISTS (
				SELECT 1
				FROM message_deliveries
				WHERE message_deliveries.item_id = content_items.id
					AND (
						message_deliveries.state NOT IN ('sent', 'dead', 'blocked')
						OR message_deliveries.updated_at > ?
					)
			)
	`).bind(1_783_760_000, 1_783_760_000).all<{ detail: string }>();
	const compactionDetails = compactionPlan.results.map(({ detail }) => detail);
	expect(compactionDetails.some((detail) => (
		detail.includes('idx_content_items_compactable')
	))).toBe(true);
	expect(compactionDetails.every((detail) => (
		!detail.includes('SCAN message_deliveries')
	))).toBe(true);
});
