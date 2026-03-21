import { getParser } from '../parsers';
import { Logger } from '../utils/logger';
import { handleError, CustomError } from '../utils/error-handler';

export async function handleRSSSources(sources, { telegramClient, dbService, config }) {
	const tasks = sources.map(async (source) => {
		try {
			const parser = getParser(source.parser);
			const feed = await fetchRSSFeed(source.url);
			const items = parser(feed);
			const newItems = await filterNewItems(dbService, items, source);

			await processNewItems(telegramClient, dbService, source, newItems, config);

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
	const latestItem = await dbService.getLatestSentItemBySource(source.name);
	const latestPubDate = latestItem ? new Date(latestItem.pubDate) : null;

	return items
		.filter(item => {
			const itemPubDate = new Date(item.pubDate);
			return !latestPubDate || itemPubDate > latestPubDate;
		})
		.sort((a, b) => new Date(a.pubDate) - new Date(b.pubDate));
}

async function processNewItems(telegramClient, dbService, source, items, config) {
	for (const item of items) {
		const claimed = await dbService.tryClaimItem(item, source.name);
		if (!claimed) {
			continue;
		}

		try {
			if (item.image) {
				try {
					await telegramClient.sendPhoto(
						source.chatId,
						item.image,
						item.message,
						source.parseMode
					);
				} catch (photoError) {
					// 如果图片发送失败，回退到文本消息
					Logger.error(`Failed to send photo for item ${item.guid}, falling back to text`, {
						imageUrl: item.image,
						error: photoError.message
					});

					await telegramClient.sendMessage(
						source.chatId,
						item.message,
						source.parseMode
					);
				}
			} else {
				await telegramClient.sendMessage(
					source.chatId,
					item.message,
					source.parseMode
				);
			}

			try {
				await dbService.markItemSent(item, source.name);
			} catch (markSentError) {
				handleError(markSentError, `Marking sent item: ${item.guid}`);
				continue;
			}

			// 遵守 Telegram API 速率限制
			await new Promise(resolve =>
				setTimeout(resolve, config.telegram.rateLimitDelay)
			);
		} catch (error) {
			try {
				await dbService.markItemFailed(item, source.name, error.message);
			} catch (markFailedError) {
				handleError(markFailedError, `Marking failed item: ${item.guid}`);
			}

			handleError(error, `Processing item: ${item.guid}`);
		}
	}
}
