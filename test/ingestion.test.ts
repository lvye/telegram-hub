import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig, type TwitterApiIoSourceConfig } from '../src/config';
import { formatTelegramMessage } from '../src/delivery/telegram-formatter';
import type { ItemInput } from '../src/domain/delivery';
import { ingestSources } from '../src/ingestion/ingest-sources';
import { DeliveryRepository } from '../src/persistence/delivery-repository';

const NEWER_ITEM = `
	<item>
		<guid>newer-guid</guid>
		<title>Newer item</title>
		<description><![CDATA[Newer description]]></description>
		<link>https://example.com/newer</link>
		<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
	</item>
`;

const OLDER_ITEM = `
	<item>
		<guid>older-guid</guid>
		<title>Late older item</title>
		<description><![CDATA[Older description]]></description>
		<link>https://example.com/older</link>
		<pubDate>Thu, 09 Jul 2026 04:00:00 GMT</pubDate>
	</item>
`;

const TWITTER_API_SOURCE: TwitterApiIoSourceConfig = {
	type: 'twitterapi-io',
	sourceKey: 'TWITTER',
	destinationKey: 'telegram:TWITTER',
	chatId: 'test-twitter-chat',
	parseMode: 'HTML',
	messageFormat: 'twitter',
	pollEveryMinutes: 5,
	endpoint: 'https://api.twitterapi.io/twitter/user/last_tweets',
	apiKey: 'test-api-key',
	userId: null,
	userName: 'OpenAI',
	includeReplies: false,
	maxPages: 1,
	fallback: {
		url: 'https://example.com/twitter.xml',
		parser: 'twitter',
	},
};

const API_POLL_TIME = Date.parse('2026-07-10T04:00:00.000Z');
const API_STATE_KEY = 'twitterapi-io:user-name:openai';

describe('source ingestion', () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
			env.DB.prepare('DELETE FROM source_ingestion_state'),
			env.DB.prepare('DELETE FROM twitter_subscriptions'),
		]);
	});

	it('uses stable identity instead of a latest-date watermark', async () => {
		const config = getConfig(env);
		config.sources = [config.sources[0]];
		const fetchMock = vi.mocked(globalThis.fetch);

		fetchMock.mockResolvedValueOnce(rss(NEWER_ITEM));
		await ingestSources(env, config);

		fetchMock.mockResolvedValueOnce(rss(`${NEWER_ITEM}${OLDER_ITEM}`));
		await ingestSources(env, config);

		fetchMock.mockResolvedValueOnce(rss(`${NEWER_ITEM}${OLDER_ITEM}`));
		await ingestSources(env, config);

		const result = await env.DB.prepare(`
			SELECT external_id
			FROM items
			ORDER BY external_id
		`).all<{ external_id: string }>();

		expect(result.results).toEqual([
			{ external_id: 'newer-guid' },
			{ external_id: 'older-guid' },
		]);
	});

	it('discovers a delayed item beyond the per-run write window', async () => {
		const config = getConfig(env);
		config.sources = [config.sources[0]];
		const firstFifty = Array.from({ length: 50 }, (_, index) => feedItem(
			`window-guid-${index}`,
			'Fri, 10 Jul 2026 04:00:00 GMT',
		)).join('');
		const fetchMock = vi.mocked(globalThis.fetch);

		fetchMock.mockResolvedValueOnce(rss(firstFifty));
		await ingestSources(env, config);
		fetchMock.mockResolvedValueOnce(rss(`${firstFifty}${OLDER_ITEM}`));
		await ingestSources(env, config);

		const row = await env.DB.prepare(`
			SELECT COUNT(*) AS count
			FROM items
		`).first<{ count: number }>();
		expect(row?.count).toBe(51);
	});

	it('keeps valid feed items when another item has an invalid date', async () => {
		const config = getConfig(env);
		config.sources = [config.sources[0]];
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(rss(
			`${feedItem('invalid-date-guid', 'not-a-date')}${NEWER_ITEM}`,
		));

		await ingestSources(env, config);

		const rows = await env.DB.prepare(`
			SELECT external_id, published_at
			FROM items
			ORDER BY external_id
		`).all<{ external_id: string; published_at: number | null }>();
		expect(rows.results).toEqual([
			{ external_id: 'invalid-date-guid', published_at: null },
			{ external_id: 'newer-guid', published_at: 1_783_656_000 },
		]);
	});

	it('persists sanitized article HTML and restores it without double escaping', async () => {
		const config = getConfig(env);
		const source = config.sources[0];
		config.sources = [source];
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(rss(`
			<item>
				<guid>formatted-guid</guid>
				<title>NA&gt;EU</title>
				<description><![CDATA[<p>A &amp; <strong>B</strong></p>]]></description>
				<link>https://example.com/formatted</link>
				<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
			</item>
		`));

		await ingestSources(env, config);
		const repository = new DeliveryRepository(env.DB);
		const [{ deliveryId }] = await repository.listDispatchable();
		const lease = await repository.acquireLease(deliveryId, 'formatted-lease');

		expect(lease).toMatchObject({
			description: 'A & B',
			formattedDescription: 'A &amp; <b>B</b>',
		});
		expect(formatTelegramMessage(lease!, source)).toBe([
			'<b>NA&gt;EU</b>',
			'A &amp; <b>B</b>',
			'<a href="https://example.com/formatted">阅读更多</a>',
		].join('\n\n'));
	});

	it('does not rehydrate compacted content for an already known identity', async () => {
		const config = getConfig(env);
		config.sources = [config.sources[0]];
		const fetchMock = vi.mocked(globalThis.fetch);

		fetchMock.mockResolvedValueOnce(rss(NEWER_ITEM));
		await ingestSources(env, config);
		await env.DB.prepare(`
			UPDATE items
			SET description = NULL, metadata_json = '{}', updated_at = 123
			WHERE external_id = 'newer-guid'
		`).run();
		fetchMock.mockResolvedValueOnce(rss(NEWER_ITEM));
		await ingestSources(env, config);

		const row = await env.DB.prepare(`
			SELECT description, updated_at
			FROM items
			WHERE external_id = 'newer-guid'
		`).first<{ description: string | null; updated_at: number }>();
		expect(row).toEqual({ description: null, updated_at: 123 });
	});

	it('surfaces feed failures to the scheduled invocation', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValue(new Response('unavailable', { status: 503 }));

		await expect(ingestSources(env, getConfig(env))).rejects.toThrow('Failed to ingest 2 source(s)');
	});

	it('expands active D1 subscriptions and deduplicates a tweet across accounts', async () => {
		const createdAt = Math.floor(API_POLL_TIME / 1_000);
		await env.DB.batch([
			env.DB.prepare(`
				INSERT INTO twitter_subscriptions (
					provider_state_key, user_name, status, created_at
				) VALUES (?, ?, 'active', ?)
			`).bind('twitterapi-io:subscription:alpha', 'AlphaAccount', createdAt),
			env.DB.prepare(`
				INSERT INTO twitter_subscriptions (
					provider_state_key, user_name, status, created_at
				) VALUES (?, ?, 'paused', ?)
			`).bind('twitterapi-io:subscription:paused', 'PausedAccount', createdAt),
			env.DB.prepare(`
				INSERT INTO twitter_subscriptions (
					provider_state_key, user_name, status, created_at
				) VALUES (?, ?, 'active', ?)
			`).bind('twitterapi-io:subscription:beta', 'BetaAccount', createdAt),
		]);
		const config = getConfig({
			IT_HOME_CHAT_ID: 'it-home-chat',
			TELEGRAM_BOT_TOKEN: 'telegram-token',
			TWITTER_CHAT_ID: 'twitter-chat',
			TWITTER_RSS_URL: 'https://example.com/twitter.xml',
			TWITTERAPI_IO_API_KEY: 'test-api-key',
		} as unknown as Env);
		config.sources = [config.sources[1]];
		const requestedUsers: string[] = [];
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			requestedUsers.push(new URL(request.url).searchParams.get('userName') ?? '');
			return twitterApiPage([
				tweet('900', new Date(API_POLL_TIME + 1_000).toISOString()),
			]);
		});

		await ingestSources(env, config, API_POLL_TIME);

		expect(requestedUsers.sort()).toEqual(['AlphaAccount', 'BetaAccount']);
		const counts = await env.DB.prepare(`
			SELECT
				(SELECT COUNT(*) FROM items) AS items,
				(SELECT COUNT(*) FROM deliveries) AS deliveries
		`).first<{ deliveries: number; items: number }>();
		expect(counts).toEqual({ items: 1, deliveries: 1 });
		const states = await env.DB.prepare(`
			SELECT provider, high_water_external_id
			FROM source_ingestion_state
			ORDER BY provider
		`).all<{ high_water_external_id: string; provider: string }>();
		expect(states.results).toEqual([
			{
				provider: 'twitterapi-io:subscription:alpha',
				high_water_external_id: 'twitter:900',
			},
			{
				provider: 'twitterapi-io:subscription:beta',
				high_water_external_id: 'twitter:900',
			},
		]);
	});

	it('does not poll RSS or API when all stored subscriptions are paused', async () => {
		await env.DB.prepare(`
			INSERT INTO twitter_subscriptions (
				provider_state_key, user_name, status
			) VALUES ('twitterapi-io:subscription:paused-only', 'PausedOnly', 'paused')
		`).run();
		const config = getConfig({
			IT_HOME_CHAT_ID: 'it-home-chat',
			TELEGRAM_BOT_TOKEN: 'telegram-token',
			TWITTER_CHAT_ID: 'twitter-chat',
			TWITTER_RSS_URL: 'https://example.com/twitter.xml',
			TWITTERAPI_IO_API_KEY: 'test-api-key',
		} as unknown as Env);
		config.sources = [config.sources[1]];

		await expect(ingestSources(env, config, API_POLL_TIME)).resolves.toEqual([]);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it('establishes an API cutover without replaying history, then ingests new tweets', async () => {
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		const fetchMock = vi.mocked(globalThis.fetch);

		fetchMock.mockResolvedValueOnce(twitterApiPage([
			tweet('100', '2020-01-01T00:00:00.000Z'),
		]));
		await ingestSources(env, config, API_POLL_TIME);
		expect(await itemCount()).toBe(0);

		fetchMock.mockResolvedValueOnce(twitterApiPage([
			tweet('101', '2100-01-01T00:00:00.000Z'),
			tweet('100', '2020-01-01T00:00:00.000Z'),
		]));
		await ingestSources(env, config, API_POLL_TIME + 5 * 60_000);

		const rows = await env.DB.prepare(`
			SELECT items.external_id, items.link, deliveries.status
			FROM items
			JOIN deliveries ON deliveries.item_id = items.id
		`).all<{ external_id: string; link: string; status: string }>();
		expect(rows.results).toEqual([{
			external_id: 'twitter:101',
			link: 'https://x.com/OpenAI/status/101',
			status: 'ready',
		}]);
	});

	it('uses the latest known RSS tweet as the API handoff high-water', async () => {
		const repository = new DeliveryRepository(env.DB);
		const lastKnownTweetAt = Math.floor(API_POLL_TIME / 1_000) - 240;
		await repository.upsertItems('TWITTER', 'telegram:TWITTER', [{
			externalId: 'legacy-rss-guid-149',
			identityAliases: ['twitter:149'],
			title: 'Known tweet',
			description: null,
			link: 'https://twitter.com/OpenAI/status/149?ref=rss',
			author: null,
			imageUrl: null,
			publishedAt: lastKnownTweetAt,
		}], lastKnownTweetAt);
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(twitterApiPage([
			tweet('150', new Date((lastKnownTweetAt + 30) * 1_000).toISOString()),
			tweet('149', new Date(lastKnownTweetAt * 1_000).toISOString()),
		]));

		await ingestSources(env, config, API_POLL_TIME);

		const state = await repository.getSourceProviderState('TWITTER', API_STATE_KEY);
		expect(state.initializedAt).toBe(lastKnownTweetAt - 60);
		expect(state.highWaterExternalId).toBe('twitter:150');
		expect(await itemCount()).toBe(2);
	});

	it('deduplicates an API tweet against a legacy RSS identity alias', async () => {
		const repository = new DeliveryRepository(env.DB);
		const existing: ItemInput = {
			externalId: 'legacy-rss-guid',
			identityAliases: ['twitter:200'],
			title: 'Already sent',
			description: null,
			link: 'https://twitter.com/OpenAI/status/200?ref=rss',
			author: null,
			imageUrl: null,
			publishedAt: 1,
		};
		await repository.upsertItems('TWITTER', 'telegram:TWITTER', [existing], 1);
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(twitterApiPage([
			tweet('200', '2100-01-01T00:00:00.000Z'),
		]));

		await ingestSources(env, config, 0);

		expect(await itemCount()).toBe(1);
	});

	it('resumes pagination across invocations before advancing the high-water', async () => {
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		const cursors: Array<string | null> = [];
		vi.mocked(globalThis.fetch)
			.mockImplementationOnce(async (input, init) => {
				cursors.push(new URL(new Request(input, init).url).searchParams.get('cursor'));
				return twitterApiPage([
					tweet('30', '2100-01-01T00:00:30.000Z'),
					tweet('29', '2100-01-01T00:00:29.000Z'),
				], true, 'older-page');
			})
			.mockImplementationOnce(async (input, init) => {
				cursors.push(new URL(new Request(input, init).url).searchParams.get('cursor'));
				return twitterApiPage([
					tweet('28', '2100-01-01T00:00:28.000Z'),
					tweet('27', '2100-01-01T00:00:27.000Z'),
				]);
			})
			.mockImplementationOnce(async (input, init) => {
				cursors.push(new URL(new Request(input, init).url).searchParams.get('cursor'));
				return twitterApiPage([
					tweet('31', '2100-01-01T00:00:31.000Z'),
					tweet('30', '2100-01-01T00:00:30.000Z'),
					tweet('29', '2100-01-01T00:00:29.000Z'),
				]);
			});

		await ingestSources(env, config, API_POLL_TIME);
		let state = await new DeliveryRepository(env.DB).getSourceProviderState(
			'TWITTER',
			API_STATE_KEY,
		);
		expect(state).toMatchObject({
			highWaterExternalId: null,
			nextCursor: 'older-page',
			pendingHighWaterExternalId: 'twitter:30',
		});

		await ingestSources(env, config, API_POLL_TIME + 5 * 60_000);
		state = await new DeliveryRepository(env.DB).getSourceProviderState(
			'TWITTER',
			API_STATE_KEY,
		);
		expect(state).toMatchObject({
			highWaterExternalId: 'twitter:30',
			nextCursor: null,
			pendingHighWaterExternalId: null,
		});

		await ingestSources(env, config, API_POLL_TIME + 10 * 60_000);

		expect(cursors).toEqual(['', 'older-page', '']);
		expect(await itemCount()).toBe(5);
	});

	it('falls back to the RSS provider when TwitterAPI.io is unavailable', async () => {
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
			.mockResolvedValueOnce(rss(NEWER_ITEM));

		await ingestSources(env, config, 0);

		const row = await env.DB.prepare(`
			SELECT external_id
			FROM items
		`).first<{ external_id: string }>();
		expect(row).toEqual({ external_id: 'newer-guid' });
	});

	it('applies the API cutover barrier to RSS fallback history', async () => {
		const repository = new DeliveryRepository(env.DB);
		await repository.upsertItems('TWITTER', 'telegram:TWITTER', [{
			externalId: 'latest-rss-guid',
			identityAliases: ['twitter:450'],
			title: 'Latest known tweet',
			description: null,
			link: 'https://twitter.com/OpenAI/status/450?ref=legacy',
			author: null,
			imageUrl: null,
			publishedAt: Math.floor(API_POLL_TIME / 1_000) - 60,
		}], 1);
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
			.mockResolvedValueOnce(rss(twitterRssItem(
				'new-provider-guid',
				'400',
				'Wed, 01 Jan 2020 00:00:00 GMT',
			)));

		await ingestSources(env, config, API_POLL_TIME);

		expect(await itemCount()).toBe(1);
	});

	it('keeps the RSS GUID while adding a provider-independent tweet alias', async () => {
		const config = getConfig(env);
		config.sources = [TWITTER_API_SOURCE];
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(new Response('unavailable', { status: 503 }))
			.mockResolvedValueOnce(rss(twitterRssItem(
				'rss-guid-500',
				'500',
				'Fri, 10 Jul 2026 04:00:00 GMT',
			)));

		await ingestSources(env, config, API_POLL_TIME);

		const row = await env.DB.prepare(`
			SELECT items.external_id, item_identity_aliases.alias
			FROM items
			JOIN item_identity_aliases ON item_identity_aliases.item_id = items.id
			WHERE item_identity_aliases.alias = 'twitter:500'
		`).first<{ alias: string; external_id: string }>();
		expect(row).toEqual({ alias: 'twitter:500', external_id: 'rss-guid-500' });
	});
});

function rss(items: string): Response {
	return new Response(`<rss><channel>${items}</channel></rss>`, {
		headers: { 'content-type': 'application/rss+xml' },
	});
}

function feedItem(guid: string, pubDate: string): string {
	return `
		<item>
			<guid>${guid}</guid>
			<title>${guid}</title>
			<description>${guid} description</description>
			<link>https://example.com/${guid}</link>
			<pubDate>${pubDate}</pubDate>
		</item>
	`;
}

function twitterApiPage(
	tweets: Array<Record<string, unknown>>,
	hasNextPage = false,
	nextCursor = '',
): Response {
	return Response.json({
		status: 'success',
		message: 'ok',
		tweets,
		has_next_page: hasNextPage,
		next_cursor: nextCursor,
	});
}

function twitterRssItem(guid: string, id: string, pubDate: string): string {
	return `
		<item>
			<guid>${guid}</guid>
			<title>tweet ${id}</title>
			<description>tweet ${id}</description>
			<link>https://twitter.com/OpenAI/status/${id}?ref=rss</link>
			<pubDate>${pubDate}</pubDate>
		</item>
	`;
}

function tweet(id: string, createdAt: string): Record<string, unknown> {
	return {
		id,
		url: `https://twitter.com/OpenAI/status/${id}?tracking=ignored`,
		text: `tweet ${id}`,
		createdAt,
		author: { id: '1', name: 'OpenAI', userName: 'OpenAI' },
	};
}

async function itemCount(): Promise<number> {
	const row = await env.DB.prepare('SELECT COUNT(*) AS count FROM items').first<{ count: number }>();
	return row?.count ?? 0;
}
