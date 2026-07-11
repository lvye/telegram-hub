import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { TwitterSubscriptionRepository } from '../src/persistence/twitter-subscription-repository';

describe('TwitterSubscriptionRepository', () => {
	const repository = new TwitterSubscriptionRepository(env.DB);

	beforeEach(async () => {
		await env.DB.prepare('DELETE FROM twitter_subscriptions').run();
	});

	it('loads only active subscriptions with normalized runtime values', async () => {
		await env.DB.batch([
			env.DB.prepare(`
				INSERT INTO twitter_subscriptions (
					provider_state_key, user_name, user_id, status,
					poll_every_minutes, include_replies, max_pages, created_at
				) VALUES (?, ?, ?, 'active', 10, 1, 2, 100)
			`).bind('twitterapi-io:subscription:alpha', 'AlphaAccount', '101'),
			env.DB.prepare(`
				INSERT INTO twitter_subscriptions (
					provider_state_key, user_name, status, created_at
				) VALUES (?, ?, 'paused', 200)
			`).bind('twitterapi-io:subscription:paused', 'PausedAccount'),
		]);

		await expect(repository.listAll()).resolves.toEqual([
			{
				id: 1,
				providerStateKey: 'twitterapi-io:subscription:alpha',
				userName: 'AlphaAccount',
				userId: '101',
				status: 'active',
				pollEveryMinutes: 10,
				includeReplies: true,
				maxPages: 2,
				createdAt: 100,
			},
			{
				id: 2,
				providerStateKey: 'twitterapi-io:subscription:paused',
				userName: 'PausedAccount',
				userId: null,
				status: 'paused',
				pollEveryMinutes: 5,
				includeReplies: false,
				maxPages: 1,
				createdAt: 200,
			},
		]);
	});

	it('enforces case-insensitive handles and bounded polling settings', async () => {
		await env.DB.prepare(`
			INSERT INTO twitter_subscriptions (provider_state_key, user_name)
			VALUES ('twitterapi-io:subscription:first', 'CaseSensitive')
		`).run();

		await expect(env.DB.prepare(`
			INSERT INTO twitter_subscriptions (provider_state_key, user_name)
			VALUES ('twitterapi-io:subscription:second', 'casesensitive')
		`).run()).rejects.toThrow();
		await expect(env.DB.prepare(`
			INSERT INTO twitter_subscriptions (
				provider_state_key, user_name, poll_every_minutes
			) VALUES ('twitterapi-io:subscription:invalid', 'InvalidPoll', 0)
		`).run()).rejects.toThrow();
	});
});
