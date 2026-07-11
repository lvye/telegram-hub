export type TwitterSubscriptionStatus = 'active' | 'archived' | 'paused';

export interface TwitterSubscription {
	id: number;
	providerStateKey: string;
	userName: string;
	userId: string | null;
	status: TwitterSubscriptionStatus;
	pollEveryMinutes: number;
	includeReplies: boolean;
	maxPages: number;
	createdAt: number;
}

interface TwitterSubscriptionRow {
	id: number;
	provider_state_key: string;
	user_name: string;
	user_id: string | null;
	status: TwitterSubscriptionStatus;
	poll_every_minutes: number;
	include_replies: number;
	max_pages: number;
	created_at: number;
}

export class TwitterSubscriptionRepository {
	constructor(private readonly db: D1Database) {}

	async listAll(): Promise<TwitterSubscription[]> {
		const result = await this.db.prepare(`
			SELECT
				id,
				provider_state_key,
				user_name,
				user_id,
				status,
				poll_every_minutes,
				include_replies,
				max_pages,
				created_at
			FROM twitter_subscriptions
			ORDER BY id
		`).all<TwitterSubscriptionRow>();

		return result.results.map((row) => ({
			id: row.id,
			providerStateKey: row.provider_state_key,
			userName: row.user_name,
			userId: row.user_id,
			status: row.status,
			pollEveryMinutes: row.poll_every_minutes,
			includeReplies: row.include_replies === 1,
			maxPages: row.max_pages,
			createdAt: row.created_at,
		}));
	}
}
