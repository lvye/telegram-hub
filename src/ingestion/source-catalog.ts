import type {
	AppConfig,
	RssSourceAdapterConfig,
	SourceConfig,
	TwitterApiIoSourceConfig,
	TwitterApiIoUserAdapterConfig,
} from '../config';
import type { SourceCatalog, SourceDefinition } from '../domain/ingestion';
import {
	TwitterSubscriptionRepository,
	type TwitterSubscription,
} from '../persistence/twitter-subscription-repository';
import { RSS_SOURCE_ADAPTER_KEY } from './rss-source-adapter';
import {
	TWITTER_API_IO_USER_ADAPTER_KEY,
	twitterApiStateKey,
} from './twitter-api-source-adapter';

const TWITTER_IDENTITY_NAMESPACE = 'TWITTER';

export class D1SourceCatalog implements SourceCatalog {
	constructor(
		private readonly db: D1Database,
		private readonly config: AppConfig,
	) {}

	async list(): Promise<SourceDefinition[]> {
		const subscriptions = await new TwitterSubscriptionRepository(this.db).listAll();
		if (subscriptions.length === 0) {
			return this.config.sources.map(sourceDefinition);
		}

		const nonTwitterSources = this.config.sources.filter((source) => (
			source.sourceKey !== TWITTER_IDENTITY_NAMESPACE
		));
		const activeSubscriptions = subscriptions.filter((subscription) => (
			subscription.status === 'active'
		));
		if (activeSubscriptions.length === 0) {
			return nonTwitterSources.map(sourceDefinition);
		}
		if (!this.config.twitterApiIo.apiKey) {
			throw new Error('Active Twitter subscriptions require TWITTERAPI_IO_API_KEY');
		}

		const routingSource = this.config.sources.find((source) => (
			source.sourceKey === TWITTER_IDENTITY_NAMESPACE
		));
		if (!routingSource) throw new Error('Twitter subscriptions require a Twitter source route');

		return [
			...nonTwitterSources.map(sourceDefinition),
			...activeSubscriptions.map((subscription) => sourceDefinition(
				subscriptionSource(subscription, this.config, routingSource.destinationKey),
			)),
		];
	}
}

function sourceDefinition(source: SourceConfig): SourceDefinition {
	if (source.type === 'rss') {
		return {
			sourceId: sourceId(source),
			adapterKey: RSS_SOURCE_ADAPTER_KEY,
			identityNamespace: source.sourceKey,
			destinationKey: source.destinationKey,
			pollEveryMinutes: source.pollEveryMinutes,
			config: rssAdapterConfig(source),
		};
	}

	return {
		sourceId: sourceId(source),
		adapterKey: TWITTER_API_IO_USER_ADAPTER_KEY,
		identityNamespace: source.sourceKey,
		destinationKey: source.destinationKey,
		pollEveryMinutes: source.pollEveryMinutes,
		config: twitterAdapterConfig(source),
	};
}

function rssAdapterConfig(source: Extract<SourceConfig, { type: 'rss' }>): RssSourceAdapterConfig {
	return {
		url: source.url,
		parser: source.parser,
		identityStrategy: source.identityStrategy,
	};
}

function twitterAdapterConfig(
	source: TwitterApiIoSourceConfig,
): TwitterApiIoUserAdapterConfig {
	return {
		endpoint: source.endpoint,
		apiKey: source.apiKey,
		userId: source.userId,
		userName: source.userName,
		includeReplies: source.includeReplies,
		maxPages: source.maxPages,
		fallback: source.fallback,
		providerStateKey: source.providerStateKey,
		initializationAt: source.initializationAt,
		bootstrapUserName: source.bootstrapUserName,
	};
}

function sourceId(source: SourceConfig): string {
	if (source.type === 'rss') return `rss:${source.sourceKey.toLowerCase()}`;
	return twitterApiStateKey(source);
}

function subscriptionSource(
	subscription: TwitterSubscription,
	config: AppConfig,
	destinationKey: string,
): TwitterApiIoSourceConfig {
	return {
		type: 'twitterapi-io',
		sourceKey: TWITTER_IDENTITY_NAMESPACE,
		destinationKey,
		pollEveryMinutes: subscription.pollEveryMinutes,
		endpoint: config.twitterApiIo.endpoint,
		apiKey: config.twitterApiIo.apiKey!,
		userId: subscription.userId,
		userName: subscription.userName,
		includeReplies: subscription.includeReplies,
		maxPages: subscription.maxPages,
		fallback: null,
		providerStateKey: subscription.providerStateKey,
		initializationAt: subscription.createdAt,
		bootstrapUserName: subscription.userName,
	};
}
