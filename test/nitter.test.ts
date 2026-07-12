import { describe, expect, it, vi } from 'vitest';
import type { NitterUserAdapterConfig } from '../src/config';
import type { IngestionOptions, SourceDefinition } from '../src/domain/ingestion';
import type {
	TwitterApiIoCheckpoint,
	TwitterApiIoCheckpointStore,
} from '../src/ingestion/twitter-api-checkpoint';
import {
	NITTER_USER_ADAPTER_KEY,
	NitterUserSourceAdapter,
} from '../src/ingestion/nitter-source-adapter';
import { decodeNitterHttpResponse } from '../src/ingestion/nitter-tls-client';

const CHECKPOINT: TwitterApiIoCheckpoint = {
	highWaterExternalId: 'twitter:2075500000000000000',
	initializedAt: 0,
	lastSuccessfulPollAt: null,
	nextCursor: null,
	pendingHighWaterExternalId: null,
};

const OPTIONS: IngestionOptions = {
	feedTimeoutMs: 1_000,
	maxFeedBytes: 100_000,
	maxCandidatesPerSource: 500,
	maxIdentityAliasesPerSource: 1_000,
	maxItemsPerSource: 50,
};

const SOURCE: SourceDefinition<NitterUserAdapterConfig> = {
	sourceId: 'nitter:subscription:3',
	adapterKey: NITTER_USER_ADAPTER_KEY,
	identityNamespace: 'TWITTER',
	destinationKey: 'telegram:TWITTER',
	pollEveryMinutes: 5,
	config: {
		feedUrl: 'https://nitter.net/fxtrader/rss',
		userName: 'fxtrader',
		includeReplies: false,
		providerStateKey: 'nitter:subscription:3',
		initializationAt: 0,
	},
};

describe('Nitter user timeline adapter', () => {
	it('uses a browser request profile and normalizes status identity, author, and image', async () => {
		let request: Request | null = null;
		vi.mocked(globalThis.fetch).mockImplementationOnce(async (input, init) => {
			request = new Request(input, init);
			return new Response(FEED, {
				headers: { 'content-type': 'application/rss+xml; charset=utf-8' },
			});
		});
		const checkpoints = checkpointStore();
		const adapter = new NitterUserSourceAdapter(
			checkpoints,
			(input, init) => globalThis.fetch(input, init),
		);

		const batch = await adapter.load(SOURCE, {
			options: OPTIONS,
			runId: 'run-1',
			scheduledAt: 1_783_750_000,
		});

		const capturedRequest = request as Request | null;
		expect(capturedRequest).not.toBeNull();
		expect(capturedRequest!.url).toBe('https://nitter.net/fxtrader/rss');
		expect(capturedRequest!.headers.get('user-agent')).toContain('Mozilla/5.0');
		expect(batch.telemetry).toMatchObject({ provider: 'nitter' });
		expect(batch.items).toEqual([{
			externalId: '2075591525346734292',
			identityAliases: [
				'2075591525346734292',
				'https://nitter.net/fxtrader/status/2075591525346734292#m',
				'https://x.com/fxtrader/status/2075591525346734292',
				'twitter:2075591525346734292',
			],
			title: '特朗普：伊朗希望与美方继续谈判。',
			description: '特朗普：伊朗希望与美方继续谈判。',
			link: 'https://x.com/fxtrader/status/2075591525346734292',
			author: '@fxtrader',
			imageUrl: 'https://nitter.net/pic/media%2FHM37ZlBa4AAj7KM.jpg',
			publishedAt: 1_783_694_556,
			metadata: { provider: 'nitter', parser: 'twitter' },
		}]);

		expect(batch.checkpoint).not.toBeNull();
		await batch.checkpoint!.commit(1_783_750_000);
		expect(checkpoints.commit).toHaveBeenCalledWith(
			'TWITTER',
			'nitter:subscription:3',
			CHECKPOINT,
			{
				highWaterExternalId: 'twitter:2075591525346734292',
				nextCursor: null,
				pendingHighWaterExternalId: null,
			},
			1_783_750_000,
		);
	});

	it('decodes bounded content-length and chunked TLS HTTP responses', async () => {
		const contentLength = encodedHttpResponse([
			'HTTP/1.1 200 OK',
			'Content-Type: application/rss+xml',
			'Content-Length: 6',
			'',
			'<rss/>',
		].join('\r\n'));
		const chunked = encodedHttpResponse([
			'HTTP/1.1 200 OK',
			'Transfer-Encoding: chunked',
			'',
			'3',
			'<rs',
			'3',
			's/>',
			'0',
			'',
			'',
		].join('\r\n'));

		await expect(decodeNitterHttpResponse(contentLength, 100).text()).resolves.toBe('<rss/>');
		await expect(decodeNitterHttpResponse(chunked, 100).text()).resolves.toBe('<rss/>');
		expect(() => decodeNitterHttpResponse(contentLength, 5)).toThrow(
			'Nitter TLS response exceeds 5 body bytes',
		);
	});
});

function checkpointStore(): TwitterApiIoCheckpointStore & {
	commit: ReturnType<typeof vi.fn<TwitterApiIoCheckpointStore['commit']>>;
} {
	return {
		getOrCreate: vi.fn(async () => CHECKPOINT),
		commit: vi.fn(async () => undefined),
	};
}

function encodedHttpResponse(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:dc="http://purl.org/dc/elements/1.1/" version="2.0">
	<channel>
		<item>
			<title>特朗普：伊朗希望与美方继续谈判。</title>
			<dc:creator>@fxtrader</dc:creator>
			<description><![CDATA[<p>特朗普：伊朗希望与美方继续谈判。</p>
				<img src="https://nitter.net/pic/media%2FHM37ZlBa4AAj7KM.jpg" />]]></description>
			<pubDate>Fri, 10 Jul 2026 14:42:36 GMT</pubDate>
			<guid isPermaLink="false">2075591525346734292</guid>
			<link>https://nitter.net/fxtrader/status/2075591525346734292#m</link>
		</item>
		<item>
			<title>R to @fxtrader: reply that should be excluded</title>
			<dc:creator>@fxtrader</dc:creator>
			<description><![CDATA[<p>reply that should be excluded</p>]]></description>
			<pubDate>Fri, 10 Jul 2026 13:42:36 GMT</pubDate>
			<guid isPermaLink="false">2075580000000000000</guid>
			<link>https://nitter.net/fxtrader/status/2075580000000000000#m</link>
		</item>
	</channel>
</rss>`;
