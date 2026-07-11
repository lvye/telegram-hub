import { describe, expect, it, vi } from 'vitest';
import type { AppConfig, TwitterApiIoSourceConfig } from '../src/config';
import {
	fetchTwitterApiIoBatch,
	type TwitterApiIoFetchRequest,
	TwitterApiIoError,
} from '../src/ingestion/twitterapi-io';

const SOURCE: TwitterApiIoSourceConfig = {
	type: 'twitterapi-io',
	sourceKey: 'TWITTER',
	destinationKey: 'telegram:TWITTER',
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
		identityStrategy: 'twitter-status-url',
	},
};

const OPTIONS: AppConfig['ingestion'] = {
	feedTimeoutMs: 1_000,
	maxFeedBytes: 100_000,
	maxItemsPerSource: 50,
};

describe('TwitterAPI.io client', () => {
	it('authenticates, selects the user, and normalizes tweets', async () => {
		let request: Request | null = null;
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			request = new Request(input, init);
			return pageResponse({
				tweets: [{
					id: '2070555272230384038',
					url: 'https://x.com/OpenAI/status/2070555272230384038',
					text: 'A new model',
					createdAt: 'Fri Jun 26 17:10:00 +0000 2026',
					author: { id: '1', name: 'OpenAI', userName: 'OpenAI' },
				}],
			});
		});

		const batch = await fetchBatch();

		expect(request).not.toBeNull();
		const requestUrl = new URL(request!.url);
		expect(requestUrl.searchParams.get('userName')).toBe('OpenAI');
		expect(requestUrl.searchParams.get('userId')).toBeNull();
		expect(requestUrl.searchParams.get('cursor')).toBe('');
		expect(requestUrl.searchParams.get('includeReplies')).toBe('false');
		expect(request!.headers.get('X-API-Key')).toBe('test-api-key');
		expect(batch).toMatchObject({ completed: true, stopReason: 'end' });
		expect(batch.items).toEqual([{
			externalId: 'twitter:2070555272230384038',
			identityAliases: [
				'twitter:2070555272230384038',
				'https://x.com/OpenAI/status/2070555272230384038',
			],
			title: 'A new model',
			description: null,
			link: 'https://x.com/OpenAI/status/2070555272230384038',
			author: 'OpenAI (@OpenAI)',
			imageUrl: null,
			publishedAt: 1_782_493_800,
			metadata: { provider: 'twitterapi-io', parser: 'twitter' },
		}]);
	});

	it('follows cursors up to the configured page budget', async () => {
		const cursors: Array<string | null> = [];
		vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			const cursor = new URL(request.url).searchParams.get('cursor');
			cursors.push(cursor);
			return cursor
				? pageResponse({ tweets: [tweet('2')], hasNextPage: false })
				: pageResponse({ tweets: [tweet('1')], hasNextPage: true, nextCursor: 'next-page' });
		});

		const batch = await fetchBatch({ ...SOURCE, maxPages: 2 });

		expect(cursors).toEqual(['', 'next-page']);
		expect(batch.items.map((item) => item.externalId)).toEqual(['twitter:1', 'twitter:2']);
		expect(batch).toMatchObject({ completed: true, nextCursor: null });
	});

	it('returns a resumable cursor when the per-invocation page budget is exhausted', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(pageResponse({
			tweets: [tweet('2'), tweet('1')],
			hasNextPage: true,
			nextCursor: 'older-page',
		}));

		const batch = await fetchBatch();

		expect(batch).toMatchObject({
			completed: false,
			newestExternalId: 'twitter:2',
			nextCursor: 'older-page',
			stopReason: 'page-budget',
		});
	});

	it('stops at the durable high-water without returning older tweets', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(pageResponse({
			tweets: [tweet('3'), tweet('2'), tweet('1')],
		}));

		const batch = await fetchBatch(SOURCE, {
			cursor: null,
			minimumPublishedAt: 0,
			stopAtExternalId: 'twitter:2',
		});

		expect(batch.items.map((item) => item.externalId)).toEqual(['twitter:3']);
		expect(batch).toMatchObject({ completed: true, stopReason: 'high-water' });
	});

	it('preserves retry-after metadata for rate limiting', async () => {
		vi.mocked(globalThis.fetch).mockResolvedValueOnce(Response.json(
			{ error: 429, message: 'slow down' },
			{ status: 429, headers: { 'retry-after': '7' } },
		));

		const error = await fetchBatch().catch((reason: unknown) => reason);

		expect(error).toBeInstanceOf(TwitterApiIoError);
		expect(error).toMatchObject({ status: 429, retryAfterSeconds: 7 });
		expect((error as Error).message).toContain('HTTP 429: slow down');
	});

	it('accepts a data-wrapped response and rejects an HTTP 200 application error', async () => {
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce(Response.json({
				status: 'success',
				data: {
					tweets: [tweet('3')],
					has_next_page: false,
					next_cursor: '',
				},
			}))
			.mockResolvedValueOnce(Response.json({ status: 'error', msg: 'balance exhausted' }));

		await expect(fetchBatch()).resolves.toMatchObject({
			items: [{ externalId: 'twitter:3' }],
		});
		await expect(fetchBatch()).rejects.toThrow(
			'TwitterAPI.io returned an application error: balance exhausted',
		);
	});
});

function fetchBatch(
	source = SOURCE,
	request: TwitterApiIoFetchRequest = {
		cursor: null,
		minimumPublishedAt: 0,
		stopAtExternalId: null,
	},
) {
	return fetchTwitterApiIoBatch(source, OPTIONS, request);
}

function tweet(id: string): Record<string, unknown> {
	return {
		id,
		url: `https://x.com/OpenAI/status/${id}`,
		text: `tweet ${id}`,
		createdAt: 'Fri Jun 26 17:10:00 +0000 2026',
		author: { name: 'OpenAI', userName: 'OpenAI' },
	};
}

function pageResponse({
	tweets,
	hasNextPage = false,
	nextCursor = '',
}: {
	tweets: Array<Record<string, unknown>>;
	hasNextPage?: boolean;
	nextCursor?: string;
}): Response {
	return Response.json({
		status: 'success',
		message: 'ok',
		tweets,
		has_next_page: hasNextPage,
		next_cursor: nextCursor,
	});
}
