import { getConfig } from './config';
import { handleRSSSources } from './handlers/rss';
import { handleCleanupTask } from './handlers/cleanup';
import { TelegramClient } from './services/telegram';
import { DatabaseService } from './services/database';
import { Logger } from './utils/logger';
import { handleError } from './utils/error-handler';

const handlers = {
	rss: handleRSSSources,
};

export default {
	async scheduled(event, env, ctx) {
		const config = getConfig(env);
		const now = new Date(event.scheduledTime);

		if (isDailyCleanTask(now, config)) {
			Logger.info('Starting daily cleanup task');
			ctx.waitUntil(handleCleanupTask(env, config));
		} else {
			Logger.info('Starting source update task');
			ctx.waitUntil(handleSources(env, config));
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

function isDailyCleanTask(now, config) {
	return now.getUTCHours() === config.cleanup.hour &&
		now.getUTCMinutes() === 0;
}

async function handleSources(env, config) {
	const telegramClient = new TelegramClient(env.TELEGRAM_BOT_TOKEN, config.telegram);
	const dbService = new DatabaseService(env.DB);
	const ctx = { telegramClient, dbService, config };

	const grouped = Object.groupBy(config.sources, s => s.type);
	const tasks = Object.entries(grouped).map(([type, sources]) => {
		const handler = handlers[type];
		if (!handler) {
			Logger.error(`Unknown source type: ${type}`);
			return;
		}
		return handler(sources, ctx);
	});

	await Promise.all(tasks);
}

async function handleTestRequest(env) {
	try {
		const config = getConfig(env);
		await handleSources(env, config);
		return new Response("Source update test completed successfully", {
			status: 200
		});
	} catch (error) {
		handleError(error, 'Test request');
		return new Response("Error during source update test", {
			status: 500
		});
	}
}
