import { describe, expect, it } from 'vitest';
import type { DeliveryDestinationConfig } from '../src/config';
import type { DeliveryLease } from '../src/domain/delivery';
import { formatTelegramMessage } from '../src/delivery/telegram-formatter';

const ARTICLE_DESTINATION: DeliveryDestinationConfig = {
	destinationKey: 'telegram:TEST',
	chatId: 'test-chat',
	parseMode: 'HTML',
	messageFormat: 'article',
};

const DELIVERY: DeliveryLease = {
	deliveryId: 1,
	destinationKey: ARTICLE_DESTINATION.destinationKey,
	leaseToken: 'lease',
	attemptCount: 1,
	sourceKey: 'TEST',
	externalId: 'item-1',
	title: '<breaking> & "quoted"',
	description: 'one < two & three > zero',
	link: 'https://example.com/?a=1&b="two"&c=\'three\'',
	author: null,
	imageUrl: null,
	publishedAt: 1_700_000_000,
};

const TWITTER_DESTINATION: DeliveryDestinationConfig = {
	destinationKey: 'telegram:TWITTER',
	chatId: 'twitter-chat',
	parseMode: 'HTML',
	messageFormat: 'twitter',
};

describe('formatTelegramMessage', () => {
	it('escapes Telegram HTML text and link attributes', () => {
		expect(formatTelegramMessage(DELIVERY, ARTICLE_DESTINATION)).toBe([
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
		}, TWITTER_DESTINATION)).toBe([
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
		}, ARTICLE_DESTINATION)).toBe('<b>NA&gt;EU：LYON 3:0 G2</b>');
	});

	it('uses only explicitly versioned, sanitized Telegram HTML without escaping it again', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			description: 'one bold & safe',
			formattedDescription: 'one <b>bold</b> &amp; safe',
			link: null,
		}, ARTICLE_DESTINATION)).toBe([
			'<b>&lt;breaking&gt; &amp; "quoted"</b>',
			'one <b>bold</b> &amp; safe',
		].join('\n\n'));
	});

	it('preserves IT Home paragraph breaks when revalidating stored Telegram HTML', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: '极狐阿尔法 T7 官图公布',
			description: '第一段。\n\n第二段。\n\n第三段重点。',
			formattedDescription: '第一段。\n\n第二段。\n\n第三段<b>重点</b>。',
			link: null,
		}, ARTICLE_DESTINATION)).toBe([
			'<b>极狐阿尔法 T7 官图公布</b>',
			'第一段。\n\n第二段。\n\n第三段<b>重点</b>。',
		].join('\n\n'));
	});

	it('limits previously stored article descriptions to 160 code points at delivery', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: null,
			description: '正'.repeat(400),
			formattedDescription: `<b>${'正'.repeat(400)}</b>`,
			link: null,
		}, ARTICLE_DESTINATION)).toBe(`<b>${'正'.repeat(160)}…</b>`);
	});

	it('drops non-http links from untrusted feed data', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: null,
			description: null,
			link: 'javascript:alert(1)',
		}, ARTICLE_DESTINATION)).toBe('');
	});

	it('revalidates stored rich text at the final delivery boundary', () => {
		expect(formatTelegramMessage({
			...DELIVERY,
			title: null,
			description: 'plain fallback',
			formattedDescription: '<b>safe</b><script>drop</script><a href="javascript:alert(1)"> link</a>',
			link: null,
		}, ARTICLE_DESTINATION)).toBe('<b>safe</b> link');
	});
});
