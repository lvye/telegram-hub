export function getConfig(env) {
	return {
		rss: {
			sources: [
				{
					name: 'IT_HOME',
					url: 'https://www.ithome.com/rss/',
					parser: 'it-home',
					chatId: env.IT_HOME_CHAT_ID,
					parseMode: 'HTML',
				},
				{
					name: 'TWITTER',
					url: env.TWITTER_RSS_URL,
					parser: 'twitter',
					chatId: env.TWITTER_CHAT_ID,
					parseMode: 'HTML',
				},
			],
			updateInterval: 60000,
			cleanupTime: 4,
		},
		telegram: {
			retryAttempts: 3,
			retryDelay: 1000,
			rateLimitDelay: 1000,
		},
		database: {
			batchSize: 50,
		},
	};
}
