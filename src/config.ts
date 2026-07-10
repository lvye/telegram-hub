import type { ParserName } from './parsers/types';

export const DELIVERY_QUEUE_NAME = 'telegram-delivery';
export const DELIVERY_DLQ_NAME = 'telegram-delivery-dlq';

export type TelegramParseMode = 'HTML';

export interface SourceConfig {
	type: 'rss';
	sourceKey: string;
	url: string;
	parser: ParserName;
	destinationKey: string;
	chatId: string;
	parseMode: TelegramParseMode;
}

export interface AppConfig {
	sources: SourceConfig[];
	ingestion: {
		feedTimeoutMs: number;
		maxFeedBytes: number;
		maxItemsPerSource: number;
	};
	delivery: {
		dispatchBatchSize: number;
		leaseSeconds: number;
		maxAttempts: number;
	};
	telegram: {
		requestTimeoutMs: number;
	};
	cleanup: {
		retentionDays: number;
	};
}

export function getConfig(env: Env): AppConfig {
	const itHomeChatId = requiredBinding(env.IT_HOME_CHAT_ID, 'IT_HOME_CHAT_ID');
	const twitterChatId = requiredBinding(env.TWITTER_CHAT_ID, 'TWITTER_CHAT_ID');
	const twitterRssUrl = requiredUrl(env.TWITTER_RSS_URL, 'TWITTER_RSS_URL');

	return {
		sources: [
			{
				type: 'rss',
				sourceKey: 'IT_HOME',
				url: 'https://www.ithome.com/rss/',
				parser: 'it-home',
				destinationKey: 'telegram:IT_HOME',
				chatId: itHomeChatId,
				parseMode: 'HTML',
			},
			{
				type: 'rss',
				sourceKey: 'TWITTER',
				url: twitterRssUrl,
				parser: 'twitter',
				destinationKey: 'telegram:TWITTER',
				chatId: twitterChatId,
				parseMode: 'HTML',
			},
		],
		ingestion: {
			feedTimeoutMs: 15_000,
			maxFeedBytes: 2 * 1024 * 1024,
			maxItemsPerSource: 50,
		},
		delivery: {
			dispatchBatchSize: 100,
			leaseSeconds: 120,
			maxAttempts: 5,
		},
		telegram: {
			requestTimeoutMs: 15_000,
		},
		cleanup: {
			retentionDays: 30,
		},
	};
}

export function findSourceByDestination(config: AppConfig, destinationKey: string): SourceConfig | null {
	return config.sources.find((source) => source.destinationKey === destinationKey) ?? null;
}

function requiredBinding(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing required binding: ${name}`);
	return value.trim();
}

function requiredUrl(value: string | undefined, name: string): string {
	const raw = requiredBinding(value, name);

	try {
		return new URL(raw).toString();
	} catch {
		throw new Error(`Binding ${name} must be a valid URL`);
	}
}
