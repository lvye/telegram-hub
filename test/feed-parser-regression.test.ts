import { describe, expect, it } from 'vitest';
import { itHomeParser } from '../src/parsers/it-home';
import { twitterParser } from '../src/parsers/twitter';

describe('feed parser regressions', () => {
	it('parses attributed RSS items, namespaced content, and semantic HTML', () => {
		const [item] = itHomeParser(`
			<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
				<channel>
					<item data-origin="ithome">
						<guid isPermaLink="false">article-1</guid>
						<title>NA&gt;EU：LYON 3:0 G2</title>
						<link>https://example.com/articles/1?a=1&amp;b=2</link>
						<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
						<content:encoded><![CDATA[
							<p>第一段 <strong>重点</strong></p>
							<ul><li>第一项</li><li>第二项</li></ul>
							<table><tr><th>队伍</th><th>比分</th></tr><tr><td>LYON</td><td>3:0</td></tr></table>
							<script>alert('drop me')</script>
						]]></content:encoded>
					</item>
				</channel>
			</rss>
		`);

		expect(item).toMatchObject({
			guid: 'article-1',
			title: 'NA>EU：LYON 3:0 G2',
			link: 'https://example.com/articles/1?a=1&b=2',
			pubDate: '2026-07-10T04:00:00.000Z',
			description: [
				'第一段 重点',
				'',
				'• 第一项',
				'• 第二项',
				'',
				'队伍 | 比分',
				'LYON | 3:0',
			].join('\n'),
			formattedDescription: [
				'第一段 <b>重点</b>',
				'',
				'• 第一项',
				'• 第二项',
				'',
				'<pre>队伍 | 比分\nLYON | 3:0</pre>',
			].join('\n'),
		});
		expect(item.description).not.toContain('drop me');
		expect(item.formattedDescription).not.toContain('drop me');
	});

	it('normalizes an Atom entry into the existing feed item contract', () => {
		const [item] = itHomeParser(`
			<feed xmlns="http://www.w3.org/2005/Atom">
				<entry>
					<id>atom-1</id>
					<title type="html">Atom &amp; Workers</title>
					<link rel="alternate" href="https://example.com/atom/1" />
					<updated>2026-07-10T04:00:00Z</updated>
					<content type="html"><![CDATA[<p>Atom <em>正文</em></p>]]></content>
				</entry>
			</feed>
		`);

		expect(item).toMatchObject({
			guid: 'atom-1',
			title: 'Atom & Workers',
			link: 'https://example.com/atom/1',
			pubDate: '2026-07-10T04:00:00.000Z',
			description: 'Atom 正文',
			formattedDescription: 'Atom <i>正文</i>',
		});
	});

	it('limits IT Home descriptions to 160 code points plus an ellipsis', () => {
		const [item] = itHomeParser(`
			<rss><channel><item>
				<guid>long-it-home-article</guid>
				<title>Long article</title>
				<link>https://example.com/long-article</link>
				<description><![CDATA[<p>${'正'.repeat(250)}</p>]]></description>
			</item></channel></rss>
		`);

		expect([...item.description]).toHaveLength(161);
		expect(item.description).toBe(`${'正'.repeat(160)}…`);
		expect(item.formattedDescription).toBe(`${'正'.repeat(160)}…`);
	});

	it('extracts namespaced Twitter author and image without raw XML regexes', () => {
		const [item] = twitterParser(`
			<rss
				xmlns:dc="http://purl.org/dc/elements/1.1/"
				xmlns:media="http://search.yahoo.com/mrss/"
			>
				<channel>
					<item data-provider="rss-app">
						<guid>tweet-1</guid>
						<title>Tweet &amp; entities</title>
						<link>https://x.com/OpenAI/status/1</link>
						<description><![CDATA[<p>Hello <strong>Workers</strong></p>]]></description>
						<pubDate>Fri, 10 Jul 2026 04:00:00 GMT</pubDate>
						<dc:creator><![CDATA[OpenAI]]></dc:creator>
						<media:content
							medium="image"
							type="image/jpeg"
							url="https://pbs.twimg.com/media/example.jpg?format=jpg&amp;name=large"
						/>
					</item>
				</channel>
			</rss>
		`);

		expect(item).toMatchObject({
			guid: 'tweet-1',
			title: 'Tweet & entities',
			description: 'Hello Workers',
			author: 'OpenAI',
			image: 'https://pbs.twimg.com/media/example.jpg?format=jpg&name=large',
		});
	});

	it('renders CDATA HTML and XML-escaped HTML equivalently', () => {
		const items = itHomeParser(`
			<rss><channel>
				<item>
					<guid>cdata</guid><title>CDATA</title><link>https://example.com/cdata</link>
					<description><![CDATA[<p>A &amp; <strong>B</strong></p>]]></description>
				</item>
				<item>
					<guid>escaped</guid><title>Escaped</title><link>https://example.com/escaped</link>
					<description>&lt;p&gt;A &amp;amp; &lt;strong&gt;B&lt;/strong&gt;&lt;/p&gt;</description>
				</item>
			</channel></rss>
		`);

		expect(items.map(({ description, formattedDescription }) => ({
			description,
			formattedDescription,
		}))).toEqual([
			{ description: 'A & B', formattedDescription: 'A &amp; <b>B</b>' },
			{ description: 'A & B', formattedDescription: 'A &amp; <b>B</b>' },
		]);
	});

	it('falls back to creator and skips invalid media candidates', () => {
		const [item] = twitterParser(`
			<rss xmlns:media="http://search.yahoo.com/mrss/"><channel><item>
				<guid>tweet-2</guid>
				<title>Tweet</title>
				<link>https://x.com/OpenAI/status/2</link>
				<description>Tweet body</description>
				<creator><![CDATA[Fallback Author]]></creator>
				<media:content medium="image" url="ftp://example.com/invalid.jpg" />
				<media:content medium="video" url="https://example.com/video.mp4" />
				<media:content medium="image" url="https://pbs.twimg.com/media/valid.jpg" />
			</item></channel></rss>
		`);

		expect(item).toMatchObject({
			author: 'Fallback Author',
			image: 'https://pbs.twimg.com/media/valid.jpg',
		});
	});

	it('honors Atom text constructs and arbitrary namespace prefixes', () => {
		const items = itHomeParser(`
			<a:feed xmlns:a="http://www.w3.org/2005/Atom" xmlns:x="http://www.w3.org/1999/xhtml">
				<a:entry>
					<a:id>atom-text</a:id>
					<a:title type="html">&lt;b&gt;HTML title&lt;/b&gt;</a:title>
					<a:link href="https://example.com/atom-text" />
					<a:content type="text">literal &lt;b&gt;not bold&lt;/b&gt;</a:content>
				</a:entry>
				<a:entry>
					<a:id>atom-html</a:id><a:title>HTML body</a:title>
					<a:link href="https://example.com/atom-html" />
					<a:content type="html">&lt;p&gt;real &lt;strong&gt;bold&lt;/strong&gt;&lt;/p&gt;</a:content>
				</a:entry>
				<a:entry>
					<a:id>atom-xhtml</a:id><a:title>XHTML body</a:title>
					<a:link href="https://example.com/atom-xhtml" />
					<a:content type="xhtml"><x:div><x:p>XHTML <x:em>body</x:em></x:p></x:div></a:content>
				</a:entry>
			</a:feed>
		`);

		expect(items).toMatchObject([
			{
				title: 'HTML title',
				description: 'literal <b>not bold</b>',
				formattedDescription: 'literal &lt;b&gt;not bold&lt;/b&gt;',
			},
			{
				description: 'real bold',
				formattedDescription: 'real <b>bold</b>',
			},
			{
				description: 'XHTML body',
				formattedDescription: 'XHTML <i>body</i>',
			},
		]);
	});

	it('resolves aliased RSS creator, encoded content, and media prefixes', () => {
		const [item] = twitterParser(`
			<rss xmlns:d="http://purl.org/dc/elements/1.1/"
				xmlns:c="http://purl.org/rss/1.0/modules/content/"
				xmlns:m="http://search.yahoo.com/mrss/">
				<channel><item>
					<guid>aliased-rss</guid><title>Aliased</title>
					<link>https://x.com/OpenAI/status/3</link>
					<c:encoded><![CDATA[<p>Aliased body</p>]]></c:encoded>
					<d:creator>Aliased Author</d:creator>
					<m:content medium="image" url="https://pbs.twimg.com/media/aliased.jpg" />
				</item></channel>
			</rss>
		`);

		expect(item).toMatchObject({
			description: 'Aliased body',
			author: 'Aliased Author',
			image: 'https://pbs.twimg.com/media/aliased.jpg',
		});
	});

	it('extracts a Twitter description author before truncating long text', () => {
		const [item] = twitterParser(`
			<rss><channel><item>
				<guid>long-author</guid><title>Long tweet</title>
				<link>https://x.com/alice/status/4</link>
				<description><![CDATA[<p>${'x'.repeat(450)} — Alice (@alice)</p>]]></description>
			</item></channel></rss>
		`);

		expect(item.author).toBe('Alice');
		expect([...item.description]).toHaveLength(401);
		expect(item.description.endsWith('…')).toBe(true);
	});
});
