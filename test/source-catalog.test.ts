import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';
import { D1SourceCatalog } from '../src/ingestion/source-catalog';

const BASE_ENV = {
	IT_HOME_CHAT_ID: 'it-home-chat',
	TELEGRAM_BOT_TOKEN: 'telegram-token',
	TWITTER_CHAT_ID: 'twitter-chat',
	TWITTER_RSS_URL: 'https://example.com/twitter.xml',
} as unknown as Env;

describe('D1SourceCatalog', () => {
	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM twitter_subscriptions').run();
	});

	it('expands active subscriptions into isolated runtime instances', async () => {
		await env.DB.batch([
			subscription('state:alpha', 'AlphaAccount', 'active', 1, 3, 1),
			subscription('state:beta', 'BetaAccount', 'active', 5, 2, 0),
			subscription('state:paused', 'PausedAccount', 'paused', 5, 1, 0),
			subscription('state:archived', 'ArchivedAccount', 'archived', 5, 1, 0),
		]);
		const config = getConfig({
			...BASE_ENV,
			TWITTERAPI_IO_API_KEY: 'api-key',
		} as Env);

		const sources = await new D1SourceCatalog(env.DB, config).list();

		expect(sources.map(({ sourceId }) => sourceId)).toEqual([
			'rss:it_home',
			'state:alpha',
			'state:beta',
		]);
		for (const source of sources.slice(1)) {
			expect(source).toMatchObject({
				adapterKey: 'twitterapi-io.user-timeline',
				identityNamespace: 'TWITTER',
				destinationKey: 'telegram:TWITTER',
			});
			expect(source).not.toHaveProperty('chatId');
			expect(source.config).not.toHaveProperty('chatId');
			expect(source.config).not.toHaveProperty('messageFormat');
			expect(source.config).not.toHaveProperty('sourceKey');
			expect(source.config).not.toHaveProperty('destinationKey');
		}
		expect(sources[1]).toMatchObject({
			pollEveryMinutes: 1,
			config: {
				userName: 'AlphaAccount',
				includeReplies: true,
				maxPages: 3,
			},
		});
		expect(sources[2]).toMatchObject({
			pollEveryMinutes: 5,
			config: {
				userName: 'BetaAccount',
				includeReplies: false,
				maxPages: 2,
			},
		});
	});

	it('preserves empty-table and paused-only semantics', async () => {
		const config = getConfig(BASE_ENV);
		const catalog = new D1SourceCatalog(env.DB, config);

		expect((await catalog.list()).map(({ sourceId }) => sourceId)).toEqual([
			'rss:it_home',
			'rss:twitter',
		]);

		await env.DB.batch([
			subscription('state:paused', 'PausedAccount', 'paused', 5, 1, 0),
			subscription('state:archived', 'ArchivedAccount', 'archived', 5, 1, 0),
		]);
		expect((await catalog.list()).map(({ sourceId }) => sourceId)).toEqual([
			'rss:it_home',
		]);
	});

	it('rejects active subscriptions without provider credentials', async () => {
		await env.DB.batch([
			subscription('state:active', 'ActiveAccount', 'active', 5, 1, 0),
		]);

		await expect(new D1SourceCatalog(env.DB, getConfig(BASE_ENV)).list()).rejects.toThrow(
			'Active Twitter subscriptions require TWITTERAPI_IO_API_KEY',
		);
	});
});

function subscription(
	providerStateKey: string,
	userName: string,
	status: 'active' | 'archived' | 'paused',
	pollEveryMinutes: number,
	maxPages: number,
	includeReplies: 0 | 1,
): D1PreparedStatement {
	return env.DB.prepare(`
		INSERT INTO twitter_subscriptions (
			provider_state_key,
			user_name,
			status,
			poll_every_minutes,
			max_pages,
			include_replies
		) VALUES (?, ?, ?, ?, ?, ?)
	`).bind(
		providerStateKey,
		userName,
		status,
		pollEveryMinutes,
		maxPages,
		includeReplies,
	);
}
