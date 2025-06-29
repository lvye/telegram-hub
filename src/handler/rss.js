import { config } from '../config';
import { getParser } from '../parsers';
import { TelegramClient } from '../services/telegram';
import { DatabaseService } from '../services/database';
import { Logger } from '../utils/logger';
import { handleError, CustomError } from '../utils/error-handler';

export async function handleRSSUpdate(env) {
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

// 批量处理
async function processNewItemsBatch(telegramClient, dbService, source, items) {
    if (items.length > 0) {
        try {
            await dbService.saveItemsBatch(items, source.name);
        } catch (error) {
            handleError(error, `Batch saving items for source: ${source.name}`);
        }
    }

    // 分批发送消息
    const batchSize = 5; // 每批处理5条消息
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = items.slice(i, i + batchSize);
        await Promise.all(batch.map(item => sendItemToTelegram(telegramClient, source, item)));

        // 批次间暂停，避免触发速率限制
        if (i + batchSize < items.length) {
            await new Promise(resolve =>
                setTimeout(resolve, config.telegram.rateLimitDelay * 2)
            );
        }
    }
}

async function sendItemToTelegram(telegramClient, source, item) {
    try {
        if (item.image) {
            return await telegramClient.sendPhoto(
                source.chatId,
                item.image,
                item.message,
                source.parseMode
            );
        } else {
            return await telegramClient.sendMessage(
                source.chatId,
                item.message,
                source.parseMode
            );
        }
    } catch (error) {
        handleError(error, `Processing item: ${item.guid}`);
    }
}
