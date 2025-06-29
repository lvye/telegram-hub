import { config } from './config';
import { handleRSSUpdate } from './handlers/rss';
import { handleCleanupTask } from './handlers/cleanup';
import { Logger } from './utils/logger';
import { handleError } from './utils/error-handler';

export default {
	async scheduled(event, env, ctx) {
		const now = new Date(event.scheduledTime);

		if (isDailyCleanTask(now)) {
			Logger.info('Starting daily cleanup task');
			ctx.waitUntil(handleCleanupTask(env));
		} else {
			Logger.info('Starting RSS update task');
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

function isDailyCleanTask(now) {
	return now.getUTCHours() === config.rss.cleanupTime &&
		now.getUTCMinutes() === 0;
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
