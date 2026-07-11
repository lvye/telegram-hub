import { XMLParser as FastXmlParser } from 'fast-xml-parser';
import { renderHtmlForTelegram } from '../delivery/telegram-html-serializer';
import type { ParsedFeedItem } from '../parsers/types';
import { decodeHtmlEntities } from './text';

type XmlRecord = Record<string, unknown>;
type FeedKind = 'atom' | 'rss';

const parser = new FastXmlParser({
	allowBooleanAttributes: true,
	ignoreAttributes: false,
	ignoreDeclaration: true,
	ignorePiTags: true,
	parseAttributeValue: false,
	parseTagValue: false,
	processEntities: false,
	// Feed namespace prefixes are arbitrary. Local names plus structural
	// attributes are sufficient to distinguish Atom content from media content.
	removeNSPrefix: true,
	stopNodes: [
		'*.description',
		'*.encoded',
		'*.summary',
		'*.content',
		'*.title',
	],
	trimValues: false,
});

export class XMLParser {
	static parseRSS(content: string): ParsedFeedItem[] {
		try {
			if (containsDtdDeclaration(content)) {
				throw new Error('DOCTYPE and ENTITY declarations are not supported');
			}

			const document = asRecord(parser.parse(content));
			const { entries, kind } = findFeedEntries(document);
			if (entries.length === 0) throw new Error('No items found in RSS or Atom feed');

			return entries.map((entry) => this.parseBaseItem(entry, kind));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to parse RSS feed: ${message}`, { cause: error });
		}
	}

	static parseDate(dateStr: string): string | null {
		if (!dateStr) return null;
		const timestamp = Date.parse(dateStr);
		return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
	}

	private static parseBaseItem(entry: XmlRecord, kind: FeedKind): ParsedFeedItem {
		const link = kind === 'atom' ? atomLink(entry.link) : xmlScalar(entry.link);
		const description = kind === 'atom'
			? firstAtomDescription(entry.content, entry.summary)
			: firstDescription(entry.description, entry.encoded);
		const imageCandidates = mediaImageUrls(entry.content);

		return {
			guid: kind === 'atom' ? xmlScalar(entry.id) || link : xmlScalar(entry.guid) || link,
			title: kind === 'atom' ? atomTitle(entry.title) : xmlScalar(entry.title),
			description,
			link,
			pubDate: this.parseDate(kind === 'atom'
				? xmlScalar(entry.published) || xmlScalar(entry.updated)
				: xmlScalar(entry.pubDate)),
			author: kind === 'atom'
				? atomAuthor(entry.author)
				: firstScalar(entry.creator),
			image: imageCandidates[0] ?? null,
			imageCandidates: imageCandidates.length > 0 ? imageCandidates : undefined,
		};
	}
}

function findFeedEntries(document: XmlRecord): { entries: XmlRecord[]; kind: FeedKind } {
	const rss = asRecord(document.rss);
	const channel = asRecord(rss.channel ?? document.channel);
	const rssItems = records(channel.item);
	if (rssItems.length > 0) return { entries: rssItems, kind: 'rss' };

	const atom = asRecord(document.feed);
	const atomEntries = records(atom.entry);
	if (atomEntries.length > 0) return { entries: atomEntries, kind: 'atom' };

	const rdf = asRecord(document.RDF);
	return { entries: records(rdf.item), kind: 'rss' };
}

function firstDescription(...values: unknown[]): string {
	for (const value of values.flatMap(asArray)) {
		const description = htmlSource(value);
		if (description.trim()) return description;
	}
	return '';
}

function firstAtomDescription(...values: unknown[]): string {
	for (const value of values.flatMap(asArray)) {
		if (isMediaNode(value)) continue;
		const description = atomTextConstruct(value);
		if (description.trim()) return description;
	}
	return '';
}

function atomTextConstruct(value: unknown): string {
	const record = asRecord(value);
	const type = xmlScalar(record['@_type']).toLowerCase() || 'text';
	return type === 'text' || type.startsWith('text/plain')
		? escapeHtmlText(xmlScalar(value))
		: htmlSource(value);
}

function atomTitle(value: unknown): string {
	const record = asRecord(value);
	const type = xmlScalar(record['@_type']).toLowerCase() || 'text';
	if (type === 'text' || type.startsWith('text/plain')) return xmlScalar(value);
	return renderHtmlForTelegram(htmlSource(value)).text;
}

function htmlSource(value: unknown): string {
	const raw = rawScalar(value).trim();
	if (!raw) return '';
	if (raw.startsWith('<![CDATA[') && raw.endsWith(']]>')) {
		return raw.slice('<![CDATA['.length, -']]>'.length).trim();
	}

	// stopNodes returns escaped HTML before the XML entity layer is decoded.
	return decodeHtmlEntities(raw);
}

function firstScalar(value: unknown): string | undefined {
	for (const candidate of asArray(value)) {
		const scalar = xmlScalar(candidate);
		if (scalar) return scalar;
	}
	return undefined;
}

function xmlScalar(value: unknown): string {
	const raw = rawScalar(value).trim();
	if (!raw) return '';
	const withoutCdata = raw.startsWith('<![CDATA[') && raw.endsWith(']]>')
		? raw.slice('<![CDATA['.length, -']]>'.length)
		: raw;
	return decodeHtmlEntities(withoutCdata).trim();
}

function rawScalar(value: unknown): string {
	if (value === undefined || value === null) return '';
	if (typeof value === 'string') return value;
	if (typeof value === 'number' || typeof value === 'boolean') return String(value);
	if (Array.isArray(value)) return rawScalar(value[0]);
	const record = asRecord(value);
	return rawScalar(record['#text'] ?? record['#cdata']);
}

function atomLink(value: unknown): string {
	const links = records(value);
	const preferred = links.find((link) => {
		const relation = xmlScalar(link['@_rel']);
		return !relation || relation === 'alternate';
	}) ?? links[0];
	if (preferred) return xmlScalar(preferred['@_href']) || xmlScalar(preferred['#text']);
	return xmlScalar(value);
}

function atomAuthor(value: unknown): string | undefined {
	for (const author of asArray(value)) {
		const record = asRecord(author);
		const name = xmlScalar(record.name) || xmlScalar(author);
		if (name) return name;
	}
	return undefined;
}

function mediaImageUrls(value: unknown): string[] {
	const urls: string[] = [];
	for (const media of records(value)) {
		if (!isMediaContent(media)) continue;
		const url = xmlScalar(media['@_url']);
		if (url) urls.push(url);
	}
	return [...new Set(urls)];
}

function isMediaContent(value: unknown): boolean {
	const media = asRecord(value);
	const medium = xmlScalar(media['@_medium']).toLowerCase();
	const type = xmlScalar(media['@_type']).toLowerCase();
	return isMediaNode(media) && (medium === 'image' || type.startsWith('image/'));
}

function isMediaNode(value: unknown): boolean {
	const media = asRecord(value);
	return Boolean(media['@_url'] ?? media['@_src'])
		&& Boolean(media['@_medium'] ?? media['@_type']);
}

function containsDtdDeclaration(content: string): boolean {
	let index = 0;
	while (index < content.length) {
		if (content.startsWith('<![CDATA[', index)) {
			const end = content.indexOf(']]>', index + '<![CDATA['.length);
			index = end < 0 ? content.length : end + 3;
			continue;
		}
		if (content.startsWith('<!--', index)) {
			const end = content.indexOf('-->', index + '<!--'.length);
			index = end < 0 ? content.length : end + 3;
			continue;
		}
		if (content.startsWith('<?', index)) {
			const end = content.indexOf('?>', index + 2);
			index = end < 0 ? content.length : end + 2;
			continue;
		}
		if (content.startsWith('<!', index)) {
			let nameStart = index + 2;
			while (/\s/u.test(content[nameStart] ?? '')) nameStart += 1;
			const declaration = content.slice(nameStart, nameStart + 8).toUpperCase();
			if (declaration.startsWith('DOCTYPE') || declaration.startsWith('ENTITY')) return true;
		}
		index += 1;
	}
	return false;
}

function escapeHtmlText(value: string): string {
	return value
		.replace(/&/gu, '&amp;')
		.replace(/</gu, '&lt;')
		.replace(/>/gu, '&gt;');
}

function records(value: unknown): XmlRecord[] {
	return asArray(value).map(asRecord).filter((record) => Object.keys(record).length > 0);
}

function asArray(value: unknown): unknown[] {
	if (value === undefined || value === null) return [];
	return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): XmlRecord {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? value as XmlRecord
		: {};
}
