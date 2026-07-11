import type { SourceDefinition } from '../domain/ingestion';

export type SourceRuntimeStatus =
	| 'backoff'
	| 'blocked'
	| 'dead'
	| 'idle'
	| 'paused'
	| 'queued'
	| 'running';

export interface SourceRuntimeState {
	sourceId: string;
	adapterKey: string;
	identityNamespace: string;
	destinationKey: string;
	pollEverySeconds: number;
	status: SourceRuntimeStatus;
	nextPollAt: number;
	queueToken: string | null;
	queuedAt: number | null;
	queueExpiresAt: number | null;
	leaseToken: string | null;
	leaseExpiresAt: number | null;
	consecutiveFailures: number;
	lastAttemptAt: number | null;
	lastSuccessAt: number | null;
	lastErrorCode: string | null;
	lastError: string | null;
	createdAt: number;
	updatedAt: number;
}

interface SourceRuntimeStateRow {
	source_id: string;
	adapter_key: string;
	identity_namespace: string;
	destination_key: string;
	poll_every_seconds: number;
	status: SourceRuntimeStatus;
	next_poll_at: number;
	queue_token: string | null;
	queued_at: number | null;
	queue_expires_at: number | null;
	lease_token: string | null;
	lease_expires_at: number | null;
	consecutive_failures: number;
	last_attempt_at: number | null;
	last_success_at: number | null;
	last_error_code: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

export interface SourceReadinessIssue {
	sourceId: string;
	status: SourceRuntimeStatus;
	lastSuccessAt: number | null;
	staleAfterSeconds: number;
	reason: 'blocked' | 'dead' | 'never_succeeded' | 'stale';
}

const MAX_ERROR_LENGTH = 1_000;

export class SourceRuntimeStateRepository {
	constructor(private readonly db: D1Database) {}

	async syncSources(sources: SourceDefinition[], scheduledAt: number): Promise<void> {
		const statements = sources.map((source) => this.db.prepare(`
			INSERT INTO source_runtime_state (
				source_id,
				adapter_key,
				identity_namespace,
				destination_key,
				poll_every_seconds,
				status,
				next_poll_at,
				created_at,
				updated_at
			)
			VALUES (?, ?, ?, ?, ?, 'idle', ?, ?, ?)
			ON CONFLICT (source_id) DO UPDATE SET
				adapter_key = excluded.adapter_key,
				identity_namespace = excluded.identity_namespace,
				destination_key = excluded.destination_key,
				poll_every_seconds = excluded.poll_every_seconds,
				status = CASE
					WHEN source_runtime_state.status = 'paused' THEN 'idle'
					ELSE source_runtime_state.status
				END,
				next_poll_at = CASE
					WHEN source_runtime_state.status = 'paused' THEN excluded.next_poll_at
					ELSE source_runtime_state.next_poll_at
				END,
				updated_at = excluded.updated_at
		`).bind(
			source.sourceId,
			source.adapterKey,
			source.identityNamespace,
			source.destinationKey,
			source.pollEveryMinutes * 60,
			nextDueAt(scheduledAt, source.pollEveryMinutes),
			scheduledAt,
			scheduledAt,
		));

		statements.push(this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'paused',
				queue_token = NULL,
				queued_at = NULL,
				queue_expires_at = NULL,
				lease_token = NULL,
				lease_expires_at = NULL,
				updated_at = ?
			WHERE source_id NOT IN (
				SELECT CAST(value AS TEXT) FROM json_each(?)
			)
				AND status <> 'paused'
		`).bind(
			scheduledAt,
			JSON.stringify(sources.map(({ sourceId }) => sourceId)),
		));

		await this.db.batch(statements);
	}

	async acquireLease(
		sourceId: string,
		leaseToken: string,
		now: number,
		leaseSeconds: number,
	): Promise<boolean> {
		assertNonEmpty(sourceId, 'sourceId');
		assertNonEmpty(leaseToken, 'leaseToken');
		if (!Number.isInteger(leaseSeconds) || leaseSeconds <= 0) {
			throw new Error('leaseSeconds must be a positive integer');
		}

		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'running',
				queue_token = NULL,
				queued_at = NULL,
				queue_expires_at = NULL,
				lease_token = ?,
				lease_expires_at = ?,
				last_attempt_at = ?,
				updated_at = ?
			WHERE source_id = ?
				AND status IN ('idle', 'backoff', 'running')
				AND (lease_token IS NULL OR lease_expires_at <= ?)
		`).bind(
			leaseToken,
			now + leaseSeconds,
			now,
			now,
			sourceId,
			now,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async listDueSourceIds(now: number, limit = 100): Promise<string[]> {
		const result = await this.db.prepare(`
			SELECT source_id
			FROM source_runtime_state
			WHERE next_poll_at <= ?
				AND (
					status IN ('idle', 'backoff')
					OR (status = 'queued' AND queue_expires_at <= ?)
					OR (status = 'running' AND lease_expires_at <= ?)
				)
			ORDER BY next_poll_at ASC, source_id ASC
			LIMIT ?
		`).bind(now, now, now, limit).all<{ source_id: string }>();

		return result.results.map(({ source_id }) => source_id);
	}

	async claimForQueue(
		sourceId: string,
		queueToken: string,
		now: number,
		claimSeconds: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'queued',
				queue_token = ?,
				queued_at = ?,
				queue_expires_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				updated_at = ?
			WHERE source_id = ?
				AND next_poll_at <= ?
				AND (
					status IN ('idle', 'backoff')
					OR (status = 'queued' AND queue_expires_at <= ?)
					OR (status = 'running' AND lease_expires_at <= ?)
				)
		`).bind(
			queueToken,
			now,
			now + claimSeconds,
			now,
			sourceId,
			now,
			now,
			now,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async releaseQueueClaim(sourceId: string, queueToken: string, now: number): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'idle',
				queue_token = NULL,
				queued_at = NULL,
				queue_expires_at = NULL,
				next_poll_at = MIN(next_poll_at, ?),
				updated_at = ?
			WHERE source_id = ? AND status = 'queued' AND queue_token = ?
		`).bind(now, now, sourceId, queueToken).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async acquireQueuedLease(
		sourceId: string,
		queueToken: string,
		leaseToken: string,
		now: number,
		leaseSeconds: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'running',
				queue_token = NULL,
				queued_at = NULL,
				queue_expires_at = NULL,
				lease_token = ?,
				lease_expires_at = ?,
				last_attempt_at = ?,
				updated_at = ?
			WHERE source_id = ?
				AND status = 'queued'
				AND queue_token = ?
				AND next_poll_at <= ?
		`).bind(
			leaseToken,
			now + leaseSeconds,
			now,
			now,
			sourceId,
			queueToken,
			now,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async scheduleQueueRetry(
		sourceId: string,
		leaseToken: string,
		queueToken: string,
		nextPollAt: number,
		queueExpiresAt: number,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'queued',
				next_poll_at = ?,
				queue_token = ?,
				queued_at = ?,
				queue_expires_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				consecutive_failures = consecutive_failures + 1,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE source_id = ? AND status = 'running' AND lease_token = ?
		`).bind(
			nextPollAt,
			queueToken,
			now,
			queueExpiresAt,
			errorCode,
			errorMessage.slice(0, MAX_ERROR_LENGTH),
			now,
			sourceId,
			leaseToken,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async reconcileDeadLetter(
		sourceId: string,
		queueToken: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'dead',
				queue_token = NULL,
				queued_at = NULL,
				queue_expires_at = NULL,
				lease_token = NULL,
				lease_expires_at = NULL,
				last_error_code = 'INGESTION_QUEUE_DEAD_LETTERED',
				last_error = COALESCE(last_error, 'Cloudflare Queue retries were exhausted'),
				updated_at = ?
			WHERE source_id = ?
				AND (
					(status = 'queued' AND queue_token = ?)
					OR (status = 'running' AND lease_expires_at <= ?)
				)
		`).bind(now, sourceId, queueToken, now).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async markBlocked(
		sourceId: string,
		leaseToken: string,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'blocked',
				lease_token = NULL,
				lease_expires_at = NULL,
				consecutive_failures = consecutive_failures + 1,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE source_id = ? AND status = 'running' AND lease_token = ?
		`).bind(
			errorCode,
			errorMessage.slice(0, MAX_ERROR_LENGTH),
			now,
			sourceId,
			leaseToken,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async recoverDeadSources(now: number, deadRecoverySeconds: number): Promise<number> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'backoff',
				next_poll_at = ?,
				updated_at = ?,
				last_error_code = 'INGESTION_DLQ_RECOVERY',
				last_error = 'Retrying source after ingestion DLQ recovery cooldown'
			WHERE status = 'dead' AND updated_at <= ?
		`).bind(now, now, now - deadRecoverySeconds).run();
		return result.meta.changes ?? 0;
	}

	async recoverBlockedSources(now: number, blockedRecoverySeconds: number): Promise<number> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'backoff',
				next_poll_at = ?,
				updated_at = ?,
				last_error_code = 'INGESTION_BLOCKED_RECOVERY',
				last_error = 'Retrying blocked source after recovery cooldown'
			WHERE status = 'blocked' AND updated_at <= ?
		`).bind(now, now, now - blockedRecoverySeconds).run();
		return result.meta.changes ?? 0;
	}

	async listReadinessIssues(
		now: number,
		minimumStaleSeconds: number,
		pollMultiplier: number,
	): Promise<SourceReadinessIssue[]> {
		const result = await this.db.prepare(`
			SELECT source_id, status, last_success_at, poll_every_seconds, created_at
			FROM source_runtime_state
			WHERE status <> 'paused'
			ORDER BY source_id
		`).all<Pick<SourceRuntimeStateRow,
			'source_id' | 'status' | 'last_success_at' | 'poll_every_seconds' | 'created_at'
		>>();

		return result.results.flatMap((row) => {
			const staleAfterSeconds = Math.max(
				minimumStaleSeconds,
				row.poll_every_seconds * pollMultiplier,
			);
			const reason = readinessReason(row, now, staleAfterSeconds);
			return reason ? [{
				sourceId: row.source_id,
				status: row.status,
				lastSuccessAt: row.last_success_at,
				staleAfterSeconds,
				reason,
			}] : [];
		});
	}

	async countActiveSources(): Promise<number> {
		const row = await this.db.prepare(`
			SELECT COUNT(*) AS count
			FROM source_runtime_state
			WHERE status <> 'paused'
		`).first<{ count: number }>();
		return row?.count ?? 0;
	}

	async markSucceeded(
		sourceId: string,
		leaseToken: string,
		nextPollAt: number,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'idle',
				next_poll_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				consecutive_failures = 0,
				last_success_at = ?,
				last_error_code = NULL,
				last_error = NULL,
				updated_at = ?
			WHERE source_id = ? AND status = 'running' AND lease_token = ?
		`).bind(nextPollAt, now, now, sourceId, leaseToken).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async markFailed(
		sourceId: string,
		leaseToken: string,
		nextPollAt: number,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_runtime_state
			SET
				status = 'backoff',
				next_poll_at = ?,
				lease_token = NULL,
				lease_expires_at = NULL,
				consecutive_failures = consecutive_failures + 1,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE source_id = ? AND status = 'running' AND lease_token = ?
		`).bind(
			nextPollAt,
			errorCode,
			errorMessage.slice(0, MAX_ERROR_LENGTH),
			now,
			sourceId,
			leaseToken,
		).run();

		return (result.meta.changes ?? 0) === 1;
	}

	async get(sourceId: string): Promise<SourceRuntimeState | null> {
		const row = await this.db.prepare(`
			SELECT
				source_id,
				adapter_key,
				identity_namespace,
				destination_key,
				poll_every_seconds,
				status,
				next_poll_at,
				queue_token,
				queued_at,
				queue_expires_at,
				lease_token,
				lease_expires_at,
				consecutive_failures,
				last_attempt_at,
				last_success_at,
				last_error_code,
				last_error,
				created_at,
				updated_at
			FROM source_runtime_state
			WHERE source_id = ?
		`).bind(sourceId).first<SourceRuntimeStateRow>();

		return row ? mapState(row) : null;
	}
}

function readinessReason(
	row: Pick<SourceRuntimeStateRow, 'created_at' | 'last_success_at' | 'status'>,
	now: number,
	staleAfterSeconds: number,
): SourceReadinessIssue['reason'] | null {
	if (row.status === 'blocked') return 'blocked';
	if (row.status === 'dead') return 'dead';
	if (row.last_success_at === null) {
		return now - row.created_at > staleAfterSeconds ? 'never_succeeded' : null;
	}
	return now - row.last_success_at > staleAfterSeconds ? 'stale' : null;
}

export function nextDueAt(scheduledAt: number, pollEveryMinutes: number): number {
	if (!Number.isInteger(pollEveryMinutes) || pollEveryMinutes <= 0) {
		throw new Error('pollEveryMinutes must be a positive integer');
	}
	const minute = Math.floor(scheduledAt / 60);
	const remainder = minute % pollEveryMinutes;
	const minutesUntilDue = remainder === 0 ? 0 : pollEveryMinutes - remainder;
	return scheduledAt + minutesUntilDue * 60;
}

function mapState(row: SourceRuntimeStateRow): SourceRuntimeState {
	return {
		sourceId: row.source_id,
		adapterKey: row.adapter_key,
		identityNamespace: row.identity_namespace,
		destinationKey: row.destination_key,
		pollEverySeconds: row.poll_every_seconds,
		status: row.status,
		nextPollAt: row.next_poll_at,
		queueToken: row.queue_token,
		queuedAt: row.queued_at,
		queueExpiresAt: row.queue_expires_at,
		leaseToken: row.lease_token,
		leaseExpiresAt: row.lease_expires_at,
		consecutiveFailures: row.consecutive_failures,
		lastAttemptAt: row.last_attempt_at,
		lastSuccessAt: row.last_success_at,
		lastErrorCode: row.last_error_code,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function assertNonEmpty(value: string, name: string): void {
	if (!value.trim()) throw new Error(`${name} must not be empty`);
}
