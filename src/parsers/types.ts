export type ParserName = 'it-home' | 'twitter';

export interface ParsedFeedItem {
	guid: string;
	title: string;
	description: string;
	formattedDescription?: string;
	link: string;
	pubDate: string | null;
	author?: string;
	image?: string | null;
	imageCandidates?: string[];
}

export type FeedParser = (content: string) => ParsedFeedItem[];
