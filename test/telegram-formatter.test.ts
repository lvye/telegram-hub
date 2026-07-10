import { describe, expect, it } from 'vitest';
import type { SourceConfig } from '../src/config';
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

describe('formatTelegramMessage', () => {
	it('escapes Telegram HTML text and link attributes', () => {
		expect(formatTelegramMessage(DELIVERY, SOURCE)).toBe([
			'<b>&lt;breaking&gt; &amp; "quoted"</b>',
			'one &lt; two &amp; three &gt; zero',
			'<a href="https://example.com/?a=1&amp;b=&quot;two&quot;&amp;c=&#39;three&#39;">阅读更多</a>',
		].join('\n\n'));
	});
});
