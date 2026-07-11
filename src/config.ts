import type { ParserName } from './parsers/types';

export const DELIVERY_QUEUE_NAME = 'telegram-delivery';
export const DELIVERY_DLQ_NAME = 'telegram-delivery-dlq';
export const INGESTION_QUEUE_NAME = 'source-ingestion';
export const INGESTION_DLQ_NAME = 'source-ingestion-dlq';

export type TelegramParseMode = 'HTML';
export type MessageFormat = 'article' | 'twitter';
export type IdentityStrategy = 'external-id' | 'twitter-status-url';

export interface DeliveryDestinationConfig {
	destinationKey: string;
	chatId: string;
	parseMode: TelegramParseMode;
	messageFormat: MessageFormat;
}

export interface RssSourceAdapterConfig {
	url: string;
	parser: ParserName;
	identityStrategy: IdentityStrategy;
}

export interface TwitterApiIoSourceConfig {
	type: 'twitterapi-io';
	sourceKey: string;
	destinationKey: string;
	pollEveryMinutes: number;
	endpoint: string;
	apiKey: string;
	userId: string | null;
	userName: string | null;
	includeReplies: boolean;
	maxPages: number;
	fallback: RssSourceAdapterConfig | null;
	providerStateKey?: string;
	initializationAt?: number;
	bootstrapUserName?: string;
}

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

export interface AppConfig {
	destinations: DeliveryDestinationConfig[];
	twitterApiIo: {
		apiKey: string | null;
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

type OptionalBindings = {
	TWITTERAPI_IO_API_KEY?: string;
};

export function getConfig(env: Env): AppConfig {
	return {
		destinations: [
			{
				destinationKey: 'telegram:IT_HOME',
				chatId: requiredBinding(env.IT_HOME_CHAT_ID, 'IT_HOME_CHAT_ID'),
				parseMode: 'HTML',
				messageFormat: 'article',
			},
			{
				destinationKey: 'telegram:TWITTER',
				chatId: requiredBinding(env.TWITTER_CHAT_ID, 'TWITTER_CHAT_ID'),
				parseMode: 'HTML',
				messageFormat: 'twitter',
			},
		],
		twitterApiIo: {
			apiKey: optionalBinding((env as Env & OptionalBindings).TWITTERAPI_IO_API_KEY),
		},
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

export function findDestination(
	config: AppConfig,
	destinationKey: string,
): DeliveryDestinationConfig | null {
	return config.destinations.find((destination) => (
		normalizeDestinationKey(destination.destinationKey) === normalizeDestinationKey(destinationKey)
	)) ?? null;
}

export function normalizeDestinationKey(value: string): string {
	return value.trim().toLowerCase().replaceAll('_', '-');
}

function requiredBinding(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing required binding: ${name}`);
	return value.trim();
}

function optionalBinding(value: string | undefined): string | null {
	return value?.trim() || null;
}
