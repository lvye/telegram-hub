import { describe, expect, it } from 'vitest';
import { XMLParser } from '../src/utils/xml-parser';

describe('XMLParser title entities', () => {
	it.each([
		['NA&gt;EU：LYON 3:0 G2', 'NA>EU：LYON 3:0 G2'],
		['AT&amp;T', 'AT&T'],
		['score &#62; 0 and &#x3C; 10', 'score > 0 and < 10'],
		['literal &amp;gt;', 'literal &gt;'],
	])('decodes one entity layer in %s', (encoded, decoded) => {
		const [item] = XMLParser.parseRSS(`
			<rss>
				<channel>
					<item>
						<guid>test-guid</guid>
						<title>${encoded}</title>
						<link>https://example.com/item</link>
						<description>Example</description>
						<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
					</item>
				</channel>
			</rss>
		`);

		expect(item.title).toBe(decoded);
	});

	it('decodes one layer inside CDATA without decoding nested entities twice', () => {
		const [item] = XMLParser.parseRSS(`
			<rss><channel><item>
				<guid>cdata-guid</guid>
				<title><![CDATA[literal &amp;gt; and NA&gt;EU]]></title>
				<link>https://example.com/cdata</link>
				<description>Example</description>
				<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
			</item></channel></rss>
		`);

		expect(item.title).toBe('literal &gt; and NA>EU');
	});

	it('preserves large numeric GUIDs and leading zeroes as strings', () => {
		const [item] = XMLParser.parseRSS(`
			<rss><channel><item>
				<guid>001234567890123456789</guid>
				<title>Numeric identity</title>
				<link>https://example.com/numeric</link>
				<description>Example</description>
				<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
			</item></channel></rss>
		`);

		expect(item.guid).toBe('001234567890123456789');
	});

	it('keeps item order, falls back to link identity, and tolerates invalid dates', () => {
		const items = XMLParser.parseRSS(`
			<rss><channel>
				<item>
					<title>First</title>
					<link>https://example.com/first?a=1&amp;b=2</link>
					<description>First body</description>
					<pubDate>not-a-date</pubDate>
				</item>
				<item>
					<guid>second</guid>
					<title>Second</title>
					<link>https://example.com/second</link>
					<description>Second body</description>
				</item>
			</channel></rss>
		`);

		expect(items.map((item) => item.guid)).toEqual([
			'https://example.com/first?a=1&b=2',
			'second',
		]);
		expect(items.map((item) => item.pubDate)).toEqual([null, null]);
	});

	it('reports an empty feed through the existing error boundary', () => {
		expect(() => XMLParser.parseRSS('<rss><channel /></rss>'))
			.toThrow('Failed to parse RSS feed: No items found');
	});

	it('rejects real DTD declarations without matching code inside CDATA or comments', () => {
		const [item] = XMLParser.parseRSS(`
			<rss><channel>
				<!-- example: <!ENTITY harmless "text"> -->
				<item>
					<guid>dtd-text</guid><title>DTD text</title><link>https://example.com/dtd</link>
					<description><![CDATA[<pre><!DOCTYPE html></pre>]]></description>
				</item>
			</channel></rss>
		`);

		expect(item.description).toBe('<pre><!DOCTYPE html></pre>');
		expect(() => XMLParser.parseRSS(`
			<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
			<rss><channel /></rss>
		`)).toThrow('DOCTYPE and ENTITY declarations are not supported');
	});
});
