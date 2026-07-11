import { describe, expect, it } from 'vitest';
import type { SourceConfig, TwitterApiIoSourceConfig } from '../src/config';
import type { DeliveryLease } from '../src/domain/delivery';
import { formatTelegramMessage } from '../src/delivery/telegram-formatter';

const SOURCE: SourceConfig = {
	type: 'rss',
	sourceKey: 'TEST',
	url: 'https://example.com/feed.xml',
	parser: 'it-home',
	destinationKey: 'telegram:TEST',
	chatId: 'test-chat',
	parseMode: 'HTML',
	messageFormat: 'article',
	pollEveryMinutes: 1,
};

const DELIVERY: DeliveryLease = {
	deliveryId: 1,
	destinationKey: SOURCE.destinationKey,
	leaseToken: 'lease',
	attemptCount: 1,
	sourceKey: SOURCE.sourceKey,
	externalId: 'item-1',
	title: '<breaking> & "quoted"',
	description: 'one < two & three > zero',
	link: 'https://example.com/?a=1&b="two"&c=\'three\'',
	author: null,
	imageUrl: null,
	publishedAt: 1_700_000_000,
};

const TWITTER_SOURCE: TwitterApiIoSourceConfig = {
	type: 'twitterapi-io',
	sourceKey: 'TWITTER',
	destinationKey: 'telegram:TWITTER',
	chatId: 'twitter-chat',
	parseMode: 'HTML',
	messageFormat: 'twitter',
	pollEveryMinutes: 5,
	endpoint: 'https://api.twitterapi.io/twitter/user/last_tweets',
	apiKey: 'test-key',
	userId: '1',
	userName: null,
	includeReplies: false,
	maxPages: 1,
	fallback: { url: 'https://example.com/twitter.xml', parser: 'twitter' },
};

describe('formatTelegramMessage', () => {
	it('escapes Telegram HTML text and link attributes', () => {
		expect(formatTelegramMessage(DELIVERY, SOURCE)).toBe([
			'<b>&lt;breaking&gt; &amp; "quoted"</b>',
			'one &lt; two &amp; three &gt; zero',
			'<a href="https://example.com/?a=1&amp;b=&quot;two&quot;&amp;c=&#39;three&#39;">阅读更多</a>',
		].join('\n\n'));
	});

	it('uses the Twitter message format independently of the provider type', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: 'tweet <body>',
			author: 'OpenAI (@OpenAI)',
			link: 'https://x.com/OpenAI/status/1?a=1&b=2',
		}, TWITTER_SOURCE)).toBe([
			'tweet &lt;body&gt;',
			'OpenAI (@OpenAI): <a href="https://x.com/OpenAI/status/1?a=1&amp;b=2">查看原文</a>',
		].join('\n\n'));
	});

	it('escapes a decoded greater-than sign for Telegram HTML exactly once', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: 'NA>EU：LYON 3:0 G2',
			description: null,
			link: null,
		}, SOURCE)).toBe('<b>NA&gt;EU：LYON 3:0 G2</b>');
	});

	it('uses only explicitly versioned, sanitized Telegram HTML without escaping it again', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			description: 'one bold & safe',
			formattedDescription: 'one <b>bold</b> &amp; safe',
			link: null,
		}, SOURCE)).toBe([
			'<b>&lt;breaking&gt; &amp; "quoted"</b>',
			'one <b>bold</b> &amp; safe',
		].join('\n\n'));
	});

	it('drops non-http links from untrusted feed data', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: null,
			description: null,
			link: 'javascript:alert(1)',
		}, SOURCE)).toBe('');
	});

	it('revalidates stored rich text at the final delivery boundary', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: null,
			description: 'plain fallback',
			formattedDescription: '<b>safe</b><script>drop</script><a href="javascript:alert(1)"> link</a>',
			link: null,
		}, SOURCE)).toBe('<b>safe</b> link');
	});
});
