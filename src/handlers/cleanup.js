import { DatabaseService } from '../services/database';
import { Logger } from '../utils/logger';
import { handleError } from '../utils/error-handler';

export async function handleCleanupTask(env, config) {
	try {
		const dbService = new DatabaseService(env.DB);
		await dbService.cleanOldData(config.cleanup.retentionDays);
		Logger.info('Cleanup task completed successfully');
	} catch (error) {
		handleError(error, 'Cleanup task');
	}
}
