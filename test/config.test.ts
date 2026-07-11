import { describe, expect, it } from 'vitest';
import { getConfig } from '../src/config';

const BASE_ENV = {
	IT_HOME_CHAT_ID: 'it-home-chat',
	TELEGRAM_BOT_TOKEN: 'telegram-token',
	TWITTER_CHAT_ID: 'twitter-chat',
	TWITTER_RSS_URL: 'https://example.com/twitter.xml',
} as unknown as Env;

describe('source configuration', () => {
	it('keeps RSS active until the optional API configuration is complete', () => {
		const config = getConfig({
			...BASE_ENV,
			TWITTERAPI_IO_API_KEY: 'api-key-without-user',
		} as Env);

		expect(config.sources[1]).toMatchObject({
			type: 'rss',
			sourceKey: 'TWITTER',
			url: 'https://example.com/twitter.xml',
		});
		expect(config.twitterApiIo).toMatchObject({
			apiKey: 'api-key-without-user',
			pollEveryMinutes: 5,
			maxPages: 1,
			includeReplies: false,
		});
	});

	it('selects TwitterAPI.io with cost-conscious defaults when fully configured', () => {
		const config = getConfig({
			...BASE_ENV,
			TWITTERAPI_IO_API_KEY: 'api-key',
			TWITTERAPI_IO_USER_NAME: 'OpenAI',
		} as Env);

		expect(config.sources[1]).toMatchObject({
			type: 'twitterapi-io',
			sourceKey: 'TWITTER',
			userId: null,
			userName: 'OpenAI',
			pollEveryMinutes: 5,
			maxPages: 1,
			includeReplies: false,
		});
	});

	it('prefers the stable user ID and bounds optional polling settings', () => {
		const config = getConfig({
			...BASE_ENV,
			TWITTERAPI_IO_API_KEY: 'api-key',
			TWITTERAPI_IO_USER_ID: '123456789',
			TWITTERAPI_IO_USER_NAME: 'ignored-name',
			TWITTERAPI_IO_POLL_MINUTES: '500',
			TWITTERAPI_IO_MAX_PAGES: '0',
			TWITTERAPI_IO_INCLUDE_REPLIES: 'true',
		} as Env);

		expect(config.sources[1]).toMatchObject({
			type: 'twitterapi-io',
			userId: '123456789',
			userName: null,
			pollEveryMinutes: 5,
			maxPages: 1,
			includeReplies: true,
		});
	});
});
