import { config } from './config';
import { getParser } from './parsers';
import { TelegramClient } from './services/telegram';
import { DatabaseService } from './services/database';
import { Logger } from './utils/logger';
import { handleError } from './utils/error-handler';

export default {
	async scheduled(event, env, ctx) {
		const now = new Date(event.scheduledTime);

		if (isDailyCleanTask(now)) {
			ctx.waitUntil(handleCleanupTask(env));
		} else {
			ctx.waitUntil(handleRSSUpdate(env));
		}
	},

	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === '/test') {
			return await handleTestRequest(env);
		}
		return new Response("Telegram hub", { status: 200 });
	}
};

async function handleRSSUpdate(env) {
	const { TELEGRAM_BOT_TOKEN, DB } = env;
	const telegramClient = new TelegramClient(TELEGRAM_BOT_TOKEN, config.telegram);
	const dbService = new DatabaseService(DB);

	const tasks = config.rss.sources.map(async (source) => {
		try {
			const parser = getParser(source.parser);
			const feed = await fetchRSSFeed(source.url);
			const items = parser(feed);
			const newItems = await filterNewItems(dbService, items, source);

			await processNewItems(telegramClient, dbService, source, newItems);

			Logger.info(`Successfully processed source: ${source.name}`, {
				itemCount: newItems.length
			});
		} catch (error) {
			handleError(error, `Processing RSS feed: ${source.name}`);
		}
	});

	await Promise.all(tasks);
}

async function fetchRSSFeed(url) {
	const response = await fetch(url);
	if (!response.ok) {
		throw new CustomError(
			`Failed to fetch RSS feed: ${response.statusText}`,
			'RSS_FETCH_ERROR',
			{ status: response.status }
		);
	}
	return await response.text();
}

async function filterNewItems(dbService, items, source) {
	const latestItem = await dbService.getLatestItemBySource(source.name);
	const latestPubDate = latestItem ? new Date(latestItem.pubDate) : null;

	return items
		.filter(item => {
			const itemPubDate = new Date(item.pubDate);
			return !latestPubDate || itemPubDate > latestPubDate;
		})
		.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
}

async function processNewItems(telegramClient, dbService, source, items) {
	for (const item of items) {
		try {
			if (item.image) {
				await telegramClient.sendPhoto(
					source.chatId,
					item.image,
					item.message,
					source.parseMode
				);
			} else {
				await telegramClient.sendMessage(
					source.chatId,
					item.message,
					source.parseMode
				);
			}

			await dbService.saveItem(item, source.name);

			// 遵守 Telegram API 速率限制
			await new Promise(resolve =>
				setTimeout(resolve, config.telegram.rateLimitDelay)
			);
		} catch (error) {
			handleError(error, `Processing item: ${item.guid}`);
		}
	}
}

async function handleCleanupTask(env) {
	try {
		const dbService = new DatabaseService(env.DB);
		await dbService.cleanOldData();
		Logger.info('Cleanup task completed successfully');
	} catch (error) {
		handleError(error, 'Cleanup task');
	}
}

async function handleTestRequest(env) {
	try {
		await handleRSSUpdate(env);
		return new Response("RSS update test completed successfully", {
			status: 200
		});
	} catch (error) {
		handleError(error, 'Test request');
		return new Response("Error during RSS update test", {
			status: 500
		});
	}
}

function isDailyCleanTask(now) {
	return now.getUTCHours() === config.rss.cleanupTime &&
		now.getUTCMinutes() === 0;
}