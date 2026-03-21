export function getConfig(env) {
	return {
		sources: [
			{
				type: 'rss',
				name: 'IT_HOME',
				url: 'https://www.ithome.com/rss/',
				parser: 'it-home',
				chatId: env.IT_HOME_CHAT_ID,
				parseMode: 'HTML',
			},
			{
				type: 'rss',
				name: 'TWITTER',
				url: env.TWITTER_RSS_URL,
				parser: 'twitter',
				chatId: env.TWITTER_CHAT_ID,
				parseMode: 'HTML',
			},
		],
		telegram: {
			retryAttempts: 3,
			retryDelay: 1000,
			rateLimitDelay: 1000,
		},
		database: {
			batchSize: 50,
		},
		cleanup: {
			hour: 4,
			retentionDays: 30,
		},
	};
}
