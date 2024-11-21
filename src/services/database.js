import { config } from '../config';
import { Logger } from '../utils/logger';
import { CustomError } from '../utils/error-handler';

export class DatabaseService {
    constructor(db) {
        this.db = db;
    }

    async saveItem(item, source) {
        try {
            const statement = this.db.prepare(`
                INSERT INTO pushed_items (id, title, description, link, pubDate, source)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET 
                    title = excluded.title,
                    description = excluded.description,
                    link = excluded.link,
                    pubDate = excluded.pubDate,
                    source = excluded.source
            `).bind(
                item.guid,
                item.title,
                item.description,
                item.link,
                new Date(item.pubDate).toISOString(),
                source
            );

            await statement.run();
            Logger.info(`Saved item to database`, {
                guid: item.guid,
                source
            });
        } catch (error) {
            throw new CustomError(
                'Failed to save item to database',
                'DB_SAVE_ERROR',
                { item, source }
            );
        }
    }

    async getLatestItemBySource(source) {
        try {
            return await this.db.prepare(`
                SELECT * FROM pushed_items 
                WHERE source = ? 
                ORDER BY pubDate DESC 
                LIMIT 1
            `).bind(source).first();
        } catch (error) {
            throw new CustomError(
                'Failed to get latest item',
                'DB_QUERY_ERROR',
                { source }
            );
        }
    }

    async cleanOldData() {
        try {
            const sources = await this.db.prepare(
                "SELECT DISTINCT source FROM pushed_items"
            ).all();

            for (const row of sources.results) {
                const latestItem = await this.getLatestItemBySource(row.source);
                if (latestItem) {
                    await this.db.prepare(`
                        DELETE FROM pushed_items
                        WHERE source = ? AND link != ?
                    `).bind(row.source, latestItem.link).run();
                }
            }

            Logger.info('Database cleanup completed', {
                sourcesCount: sources.results.length
            });
        } catch (error) {
            throw new CustomError(
                'Failed to clean old data',
                'DB_CLEANUP_ERROR'
            );
        }
    }
}