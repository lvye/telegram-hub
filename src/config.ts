import type { ParserName } from './parsers/types';

export const DELIVERY_QUEUE_NAME = 'telegram-delivery';
export const DELIVERY_DLQ_NAME = 'telegram-delivery-dlq';
export const INGESTION_QUEUE_NAME = 'source-ingestion';
export const INGESTION_DLQ_NAME = 'source-ingestion-dlq';
export const TWITTERAPI_IO_ENDPOINT = 'https://api.twitterapi.io/twitter/user/last_tweets';
export const NITTER_BASE_URL = 'https://nitter.net/';

export type TelegramParseMode = 'HTML';
export type MessageFormat = 'article' | 'twitter';
export type IdentityStrategy = 'external-id' | 'twitter-status-url';
export type TwitterSourceProvider = 'nitter' | 'twitterapi-io';

interface SourceConfigBase {
	sourceKey: string;
	destinationKey: string;
	pollEveryMinutes: number;
}

export interface DeliveryDestinationConfig {
	destinationKey: string;
	chatId: string;
	parseMode: TelegramParseMode;
	messageFormat: MessageFormat;
}

export interface RssSourceConfig extends SourceConfigBase {
	type: 'rss';
	url: string;
	parser: ParserName;
	identityStrategy: IdentityStrategy;
}

export interface TwitterApiIoSourceConfig extends SourceConfigBase {
	type: 'twitterapi-io';
	endpoint: string;
	apiKey: string;
	userId: string | null;
	userName: string | null;
	includeReplies: boolean;
	maxPages: number;
	fallback: Pick<RssSourceConfig, 'identityStrategy' | 'parser' | 'url'> | null;
	providerStateKey?: string;
	initializationAt?: number;
	bootstrapUserName?: string;
}

export type RssSourceAdapterConfig = Pick<
	RssSourceConfig,
	'identityStrategy' | 'parser' | 'url'
>;

export type TwitterApiIoUserAdapterConfig = Pick<
	TwitterApiIoSourceConfig,
	| 'apiKey'
	| 'bootstrapUserName'
	| 'endpoint'
	| 'fallback'
	| 'includeReplies'
	| 'initializationAt'
	| 'maxPages'
	| 'providerStateKey'
	| 'userId'
	| 'userName'
>;

export interface NitterUserAdapterConfig {
	feedUrl: string;
	userName: string;
	includeReplies: boolean;
	providerStateKey: string;
	initializationAt: number;
}

export type SourceConfig = RssSourceConfig | TwitterApiIoSourceConfig;

export interface AppConfig {
	sources: SourceConfig[];
	destinations: DeliveryDestinationConfig[];
	twitterSourceProvider: TwitterSourceProvider;
	nitter: {
		baseUrl: string;
	};
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
		leaseSeconds: number;
		queueClaimSeconds: number;
		deadRecoverySeconds: number;
		blockedRecoverySeconds: number;
		readinessMinimumSeconds: number;
		readinessPollMultiplier: number;
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
	const twitterSourceProvider = configuredTwitterSourceProvider(env);
	const nitter = nitterRuntime(env);
	const twitterApiIo = twitterApiIoRuntime(env);
	const twitterApiSource = twitterSourceProvider === 'twitterapi-io'
		? optionalTwitterApiIoSource(env, twitterRssUrl, twitterApiIo)
		: null;

	return {
		sources: [
			{
				type: 'rss',
				sourceKey: 'IT_HOME',
				url: 'https://www.ithome.com/rss/',
				parser: 'it-home',
				identityStrategy: 'external-id',
				destinationKey: 'telegram:IT_HOME',
				pollEveryMinutes: 1,
			},
			twitterApiSource ?? {
				type: 'rss',
				sourceKey: 'TWITTER',
				url: twitterRssUrl,
				parser: 'twitter',
				identityStrategy: 'twitter-status-url',
				destinationKey: 'telegram:TWITTER',
				pollEveryMinutes: 1,
			},
		],
		destinations: [
			{
				destinationKey: 'telegram:IT_HOME',
				chatId: itHomeChatId,
				parseMode: 'HTML',
				messageFormat: 'article',
			},
			{
				destinationKey: 'telegram:TWITTER',
				chatId: twitterChatId,
				parseMode: 'HTML',
				messageFormat: 'twitter',
			},
		],
		twitterSourceProvider,
		nitter,
		twitterApiIo,
		ingestion: {
			feedTimeoutMs: 15_000,
			maxFeedBytes: 2 * 1024 * 1024,
			maxItemsPerSource: 50,
			leaseSeconds: 5 * 60,
			queueClaimSeconds: 5 * 60,
			deadRecoverySeconds: 6 * 60 * 60,
			blockedRecoverySeconds: 60 * 60,
			readinessMinimumSeconds: 10 * 60,
			readinessPollMultiplier: 3,
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
	NITTER_BASE_URL?: string;
	TWITTER_SOURCE_PROVIDER?: string;
	TWITTERAPI_IO_API_KEY?: string;
	TWITTERAPI_IO_INCLUDE_REPLIES?: string;
	TWITTERAPI_IO_MAX_PAGES?: string;
	TWITTERAPI_IO_POLL_MINUTES?: string;
	TWITTERAPI_IO_USER_ID?: string;
	TWITTERAPI_IO_USER_NAME?: string;
};

function configuredTwitterSourceProvider(env: Env): TwitterSourceProvider {
	const value = optionalBinding((env as Env & OptionalTwitterApiBindings).TWITTER_SOURCE_PROVIDER)
		?? 'twitterapi-io';
	if (value === 'nitter' || value === 'twitterapi-io') return value;
	throw new Error('TWITTER_SOURCE_PROVIDER must be nitter or twitterapi-io');
}

function nitterRuntime(env: Env): AppConfig['nitter'] {
	const raw = optionalBinding((env as Env & OptionalTwitterApiBindings).NITTER_BASE_URL)
		?? NITTER_BASE_URL;
	try {
		return { baseUrl: new URL(raw).toString() };
	} catch {
		throw new Error('NITTER_BASE_URL must be a valid URL');
	}
}

function optionalTwitterApiIoSource(
	env: Env,
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
			identityStrategy: 'twitter-status-url',
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

export function findDestination(
	config: AppConfig,
	destinationKey: string,
): DeliveryDestinationConfig | null {
	return config.destinations.find((destination) => (
		destination.destinationKey === destinationKey
	)) ?? null;
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
