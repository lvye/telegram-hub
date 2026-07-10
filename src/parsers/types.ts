export type ParserName = 'it-home' | 'twitter';

export interface ParsedFeedItem {
	guid: string;
	title: string;
	description: string;
	link: string;
	pubDate: string | null;
	rawContent?: string;
	author?: string;
	image?: string | null;
}

export type FeedParser = (content: string) => ParsedFeedItem[];
