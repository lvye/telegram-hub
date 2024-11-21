export const config = {
    rss: {
        sources: [
            {
                name: "IT_HOME",
                url: "https://www.ithome.com/rss/",
                parser: "it-home",
                chatId: "",
                parseMode: "HTML"
            },
            {
                name: "TWITTER",
                url: "https://rss.app/feeds/xxx.xml",
                parser: "twitter",
                chatId: "",
                parseMode: "HTML"
            }
        ],
        updateInterval: 60000,
        cleanupTime: 4
    },
    telegram: {
        retryAttempts: 3,
        retryDelay: 1000,
        rateLimitDelay: 1000
    },
    database: {
        batchSize: 50
    }
};