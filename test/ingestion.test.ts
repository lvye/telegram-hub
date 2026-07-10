import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getConfig } from '../src/config';
import { ingestSources } from '../src/ingestion/ingest-sources';

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

describe('source ingestion', () => {
	beforeEach(async () => {
		await env.DB.batch([
			env.DB.prepare('DELETE FROM deliveries'),
			env.DB.prepare('DELETE FROM items'),
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
