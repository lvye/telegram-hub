import { renderHtmlForTelegram } from '../delivery/telegram-html-serializer';
import { XMLParser } from '../utils/xml-parser';
import type { ParsedFeedItem } from './types';

const IT_HOME_DATELINE = /IT之家\s*\d+\s*月\s*\d+\s*日消息[，,]\s*/gu;

export function itHomeParser(content: string): ParsedFeedItem[] {
	try {
		return XMLParser.parseRSS(content).map((item) => {
			const description = renderHtmlForTelegram(item.description, {
				maxTextLength: 400,
				transformText: (text) => text.replace(IT_HOME_DATELINE, ''),
			});

			return {
				...item,
				description: description.text,
				formattedDescription: description.html,
			};
		});
	} catch (error) {
		throw new Error('Failed to parse IT Home feed', { cause: error });
	}
}
