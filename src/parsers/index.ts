import { itHomeParser } from './it-home';
import { twitterParser } from './twitter';
import type { FeedParser, ParserName } from './types';

const parsers: Record<ParserName, FeedParser> = {
	'it-home': itHomeParser,
	'twitter': twitterParser,
};

export function getParser(type: ParserName): FeedParser {
	return parsers[type];
}
