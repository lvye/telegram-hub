import { describe, expect, it } from 'vitest';
import { findDestination, getConfig } from '../src/config';

const BASE_ENV = {
	IT_HOME_CHAT_ID: 'it-home-chat',
	TELEGRAM_BOT_TOKEN: 'telegram-token',
	TWITTER_CHAT_ID: 'twitter-chat',
} as Env;

describe('runtime configuration', () => {
	it('keeps delivery credentials outside source topology', () => {
		const config = getConfig(BASE_ENV);

		expect(config.destinations).toEqual([
			{
				destinationKey: 'telegram:IT_HOME',
				chatId: 'it-home-chat',
				parseMode: 'HTML',
				messageFormat: 'article',
			},
			{
				destinationKey: 'telegram:TWITTER',
				chatId: 'twitter-chat',
				parseMode: 'HTML',
				messageFormat: 'twitter',
			},
		]);
		expect(findDestination(config, 'telegram:it_home')?.chatId).toBe('it-home-chat');
	});

	it('loads optional Twitter provider credentials from bindings', () => {
		const withoutApi = getConfig(BASE_ENV);
		const withApi = getConfig({
			...BASE_ENV,
			TWITTERAPI_IO_API_KEY: 'api-key',
			X_API_BEARER_TOKEN: 'x-token',
		} as Env);

		expect(withoutApi.twitterApiIo.apiKey).toBeNull();
		expect(withoutApi.xOfficial.bearerToken).toBeNull();
		expect(withApi.twitterApiIo.apiKey).toBe('api-key');
		expect(withApi.xOfficial.bearerToken).toBe('x-token');
	});

	it('recovers dead ingestion sources after one hour', () => {
		expect(getConfig(BASE_ENV).ingestion.deadRecoverySeconds).toBe(60 * 60);
	});

	it('fails early when a required destination binding is missing', () => {
		expect(() => getConfig({
			...BASE_ENV,
			TWITTER_CHAT_ID: '',
		} as Env)).toThrow('Missing required binding: TWITTER_CHAT_ID');
	});
});
