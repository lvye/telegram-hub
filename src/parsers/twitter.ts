import { renderHtmlForTelegram } from '../delivery/telegram-html-serializer';
import { XMLParser } from '../utils/xml-parser';
import { parseDocument } from 'htmlparser2';
import { hasChildren, isTag, type ChildNode } from 'domhandler';
import type { ParsedFeedItem } from './types';

export function twitterParser(content: string): ParsedFeedItem[] {
	try {
		return XMLParser.parseRSS(content).map((item) => {
			const fullDescription = renderHtmlForTelegram(item.description).text;
			const description = truncateText(fullDescription, 400);
			const author = item.author?.trim() || authorFromDescription(fullDescription) || 'Unknown User';
			const candidates = [
				...(item.imageCandidates ?? (item.image ? [item.image] : [])),
				...descriptionImageUrls(item.description),
			];
			const image = firstValidImageUrl(candidates, item.guid);

			return {
				...item,
				description,
				author,
				image,
			};
		});
	} catch (error) {
		throw new Error('Failed to parse Twitter feed', { cause: error });
	}
}

function descriptionImageUrls(description: string): string[] {
	const document = parseDocument(description, {
		decodeEntities: true,
		lowerCaseAttributeNames: true,
		lowerCaseTags: true,
		xmlMode: false,
	});
	const urls: string[] = [];
	const stack: ChildNode[] = [...document.children].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		if (isTag(node) && node.name === 'img' && node.attribs.src?.trim()) {
			urls.push(node.attribs.src.trim());
		}
		if (hasChildren(node)) stack.push(...[...node.children].reverse());
	}
	return [...new Set(urls)];
}

function truncateText(value: string, maxLength: number): string {
	const codePoints = [...value];
	return codePoints.length <= maxLength
		? value
		: `${codePoints.slice(0, maxLength).join('')}…`;
}

function authorFromDescription(description: string): string | null {
	const match = description.match(/—\s*([^(]+)\s*\(/u);
	return match?.[1]?.trim() || null;
}

function firstValidImageUrl(urls: string[], itemGuid: string): string | null {
	for (const url of urls) {
		const valid = validateAndCleanImageUrl(url, itemGuid);
		if (valid) return valid;
	}
	return null;
}

function validateAndCleanImageUrl(url: string, itemGuid: string): string | null {
	const cleanUrl = url.trim();
	try {
		const parsed = new URL(cleanUrl);
		if (
			!['http:', 'https:'].includes(parsed.protocol)
			|| !isValidImageUrl(cleanUrl)
			|| !isValidUrlCharacters(cleanUrl)
		) {
			console.info({
				event: 'invalid_image_url',
				itemId: itemGuid,
				url: cleanUrl,
			});
			return null;
		}

		return cleanUrl;
	} catch (error) {
		console.error({
			event: 'image_url_validation_failed',
			itemId: itemGuid,
			originalUrl: url,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function isValidImageUrl(url: string): boolean {
	return url.includes('pbs.twimg.com/media/') || /\.(?:gif|jpe?g|png|webp)(?:\?|$)/iu.test(url);
}

function isValidUrlCharacters(url: string): boolean {
	return /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/u.test(url);
}
