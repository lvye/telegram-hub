import { Logger } from '../utils/logger';
import { CustomError } from '../utils/error-handler';

export class DatabaseService {
	constructor(db) {
		this.db = db;
	}

	async tryClaimItem(item, source) {
		try {
			const pubDate = item.pubDate ? new Date(item.pubDate).toISOString() : null;
			const insertResult = await this.db.prepare(`
				INSERT OR IGNORE INTO pushed_items (
					id,
					title,
					description,
					link,
					pubDate,
					source,
					status,
					createdAt,
					updatedAt,
					sentAt,
					lastError
				)
				VALUES (?, ?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, NULL, NULL)
			`).bind(
				item.guid,
				item.title,
				item.description,
				item.link,
				pubDate,
				source
			).run();

			if (this.#getAffectedRows(insertResult) > 0) {
				Logger.info('Claimed item for delivery', {
					guid: item.guid,
					source
				});
				return true;
			}

			const retryResult = await this.db.prepare(`
				UPDATE pushed_items
				SET
					title = ?,
					description = ?,
					link = ?,
					pubDate = ?,
					source = ?,
					status = 'pending',
					updatedAt = CURRENT_TIMESTAMP,
					lastError = NULL
				WHERE id = ? AND status = 'failed'
			`).bind(
				item.title,
				item.description,
				item.link,
				pubDate,
				source,
				item.guid
			).run();

			if (this.#getAffectedRows(retryResult) > 0) {
				Logger.info('Reclaimed failed item for delivery retry', {
					guid: item.guid,
					source
				});
				return true;
			}

			Logger.info('Skipping item already claimed or sent', {
				guid: item.guid,
				source
			});
			return false;
		} catch (error) {
			throw new CustomError(
				'Failed to claim item for delivery',
				'DB_CLAIM_ERROR',
				{ item, source }
			);
		}
	}

	async markItemSent(item, source) {
		try {
			await this.db.prepare(`
				UPDATE pushed_items
				SET
					title = ?,
					description = ?,
					link = ?,
					pubDate = ?,
					source = ?,
					status = 'sent',
					updatedAt = CURRENT_TIMESTAMP,
					sentAt = CURRENT_TIMESTAMP,
					lastError = NULL
				WHERE id = ?
			`).bind(
				item.title,
				item.description,
				item.link,
				item.pubDate ? new Date(item.pubDate).toISOString() : null,
				source,
				item.guid
			).run();

			Logger.info('Marked item as sent', {
				guid: item.guid,
				source
			});
		} catch (error) {
			throw new CustomError(
				'Failed to mark item as sent',
				'DB_MARK_SENT_ERROR',
				{ item, source }
			);
		}
	}

	async markItemFailed(item, source, errorMessage) {
		try {
			await this.db.prepare(`
				UPDATE pushed_items
				SET
					title = ?,
					description = ?,
					link = ?,
					pubDate = ?,
					source = ?,
					status = 'failed',
					updatedAt = CURRENT_TIMESTAMP,
					lastError = ?
				WHERE id = ?
			`).bind(
				item.title,
				item.description,
				item.link,
				item.pubDate ? new Date(item.pubDate).toISOString() : null,
				source,
				errorMessage,
				item.guid
			).run();

			Logger.info('Marked item as failed', {
				guid: item.guid,
				source
			});
		} catch (error) {
			throw new CustomError(
				'Failed to mark item as failed',
				'DB_MARK_FAILED_ERROR',
				{ item, source, errorMessage }
			);
		}
	}

	async getLatestSentItemBySource(source) {
		try {
			return await this.db.prepare(`
				SELECT * FROM pushed_items
				WHERE source = ? AND status = 'sent'
				ORDER BY pubDate DESC
				LIMIT 1
			`).bind(source).first();
		} catch (error) {
			throw new CustomError(
				'Failed to get latest sent item',
				'DB_QUERY_ERROR',
				{ source }
			);
		}
	}

	async cleanOldData(retentionDays) {
		try {
			const result = await this.db.prepare(`
				DELETE FROM pushed_items
				WHERE datetime(COALESCE(sentAt, updatedAt, createdAt)) < datetime('now', ?)
			`).bind(`-${retentionDays} days`).run();

			Logger.info('Database cleanup completed', {
				retentionDays,
				deletedCount: this.#getAffectedRows(result)
			});
		} catch (error) {
			throw new CustomError(
				'Failed to clean old data',
				'DB_CLEANUP_ERROR',
				{ retentionDays }
			);
		}
	}

	#getAffectedRows(result) {
		return result?.meta?.changes ?? result?.changes ?? 0;
	}
}
