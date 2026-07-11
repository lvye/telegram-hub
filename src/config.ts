import type { ParserName } from './parsers/types';

export const DELIVERY_QUEUE_NAME = 'telegram-delivery';
export const DELIVERY_DLQ_NAME = 'telegram-delivery-dlq';
export const TWITTERAPI_IO_ENDPOINT = 'https://api.twitterapi.io/twitter/user/last_tweets';

export type TelegramParseMode = 'HTML';
export type MessageFormat = 'article' | 'twitter';

interface SourceConfigBase {
	sourceKey: string;
	destinationKey: string;
	chatId: string;
	parseMode: TelegramParseMode;
	messageFormat: MessageFormat;
	pollEveryMinutes: number;
}

export interface RssSourceConfig extends SourceConfigBase {
	type: 'rss';
	url: string;
	parser: ParserName;
}

export interface TwitterApiIoSourceConfig extends SourceConfigBase {
	type: 'twitterapi-io';
	endpoint: string;
	apiKey: string;
	userId: string | null;
	userName: string | null;
	includeReplies: boolean;
	maxPages: number;
	fallback: Pick<RssSourceConfig, 'parser' | 'url'> | null;
	providerStateKey?: string;
	initializationAt?: number;
	bootstrapUserName?: string;
}

export type SourceConfig = RssSourceConfig | TwitterApiIoSourceConfig;

export interface AppConfig {
	sources: SourceConfig[];
	twitterApiIo: {
		apiKey: string | null;
		endpoint: string;
		includeReplies: boolean;
		maxPages: number;
		pollEveryMinutes: number;
	};
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
	const twitterApiIo = twitterApiIoRuntime(env);
	const twitterApiSource = optionalTwitterApiIoSource(
		env,
		twitterChatId,
		twitterRssUrl,
		twitterApiIo,
	);

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
				messageFormat: 'article',
				pollEveryMinutes: 1,
			},
			twitterApiSource ?? {
				type: 'rss',
				sourceKey: 'TWITTER',
				url: twitterRssUrl,
				parser: 'twitter',
				destinationKey: 'telegram:TWITTER',
				chatId: twitterChatId,
				parseMode: 'HTML',
				messageFormat: 'twitter',
				pollEveryMinutes: 1,
			},
		],
		twitterApiIo,
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

type OptionalTwitterApiBindings = {
	TWITTERAPI_IO_API_KEY?: string;
	TWITTERAPI_IO_INCLUDE_REPLIES?: string;
	TWITTERAPI_IO_MAX_PAGES?: string;
	TWITTERAPI_IO_POLL_MINUTES?: string;
	TWITTERAPI_IO_USER_ID?: string;
	TWITTERAPI_IO_USER_NAME?: string;
};

function optionalTwitterApiIoSource(
	env: Env,
	chatId: string,
	fallbackUrl: string,
	runtime: AppConfig['twitterApiIo'],
): TwitterApiIoSourceConfig | null {
	const bindings = env as Env & OptionalTwitterApiBindings;
	const userId = optionalBinding(bindings.TWITTERAPI_IO_USER_ID);
	const userName = optionalBinding(bindings.TWITTERAPI_IO_USER_NAME)?.replace(/^@/, '') || null;

	// Keep the existing RSS provider active until the API configuration is
	// complete. This makes the integration safe to deploy before secrets are set.
	if (!runtime.apiKey || (!userId && !userName)) return null;

	return {
		type: 'twitterapi-io',
		sourceKey: 'TWITTER',
		destinationKey: 'telegram:TWITTER',
		chatId,
		parseMode: 'HTML',
		messageFormat: 'twitter',
		pollEveryMinutes: runtime.pollEveryMinutes,
		endpoint: runtime.endpoint,
		apiKey: runtime.apiKey,
		userId,
		userName: userId ? null : userName,
		includeReplies: runtime.includeReplies,
		maxPages: runtime.maxPages,
		fallback: {
			url: fallbackUrl,
			parser: 'twitter',
		},
	};
}

function twitterApiIoRuntime(env: Env): AppConfig['twitterApiIo'] {
	const bindings = env as Env & OptionalTwitterApiBindings;
	return {
		apiKey: optionalBinding(bindings.TWITTERAPI_IO_API_KEY),
		endpoint: TWITTERAPI_IO_ENDPOINT,
		pollEveryMinutes: boundedInteger(bindings.TWITTERAPI_IO_POLL_MINUTES, 5, 1, 60),
		maxPages: boundedInteger(bindings.TWITTERAPI_IO_MAX_PAGES, 1, 1, 5),
		includeReplies: optionalBoolean(bindings.TWITTERAPI_IO_INCLUDE_REPLIES, false),
	};
}

export function findSourceByDestination(config: AppConfig, destinationKey: string): SourceConfig | null {
	return config.sources.find((source) => source.destinationKey === destinationKey) ?? null;
}

function requiredBinding(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing required binding: ${name}`);
	return value.trim();
}

function optionalBinding(value: string | undefined): string | null {
	return value?.trim() || null;
}

function boundedInteger(
	value: string | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
): number {
	if (!value?.trim()) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
		? parsed
		: fallback;
}

function optionalBoolean(value: string | undefined, fallback: boolean): boolean {
	if (!value?.trim()) return fallback;
	if (value.trim().toLowerCase() === 'true' || value.trim() === '1') return true;
	if (value.trim().toLowerCase() === 'false' || value.trim() === '0') return false;
	return fallback;
}

function requiredUrl(value: string | undefined, name: string): string {
	const raw = requiredBinding(value, name);

	try {
		return new URL(raw).toString();
	} catch {
		throw new Error(`Binding ${name} must be a valid URL`);
	}
}
