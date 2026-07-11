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

export interface SourceReadinessIssue {
	sourceId: string;
	status: SourceRuntimeStatus;
	lastSuccessAt: number | null;
	staleAfterSeconds: number;
	reason: 'blocked' | 'dead' | 'never_succeeded' | 'stale';
}

interface RuntimeRow {
	source_id: string;
	adapter_key: string;
	identity_namespace: string;
	destination_key: string;
	poll_every_seconds: number;
	state: 'idle' | 'queued' | 'running' | 'blocked' | 'dead';
	next_run_at: number;
	claim_token: string | null;
	claimed_at: number | null;
	claim_expires_at: number | null;
	failure_count: number;
	last_attempt_at: number | null;
	last_success_at: number | null;
	last_error_code: string | null;
	last_error: string | null;
	created_at: number;
	updated_at: number;
}

const MAX_ERROR_LENGTH = 1_000;

export class SourceRuntimeStateRepository {
	constructor(private readonly db: D1Database) {}

	async syncSources(sources: SourceDefinition[], scheduledAt: number): Promise<void> {
		const statements = sources.map((source) => this.db.prepare(`
			INSERT INTO source_connector_state (
				connector_id, state, next_run_at, created_at, updated_at
			)
			SELECT id, 'idle', ?, ?, ?
			FROM source_connectors
			WHERE connector_key = ? AND status = 'active'
			ON CONFLICT (connector_id) DO NOTHING
		`).bind(scheduledAt, scheduledAt, scheduledAt, source.sourceId));
		if (statements.length > 0) await this.db.batch(statements);
	}

	async acquireLease(
		sourceId: string,
		leaseToken: string,
		now: number,
		leaseSeconds: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'running',
				claim_token = ?,
				claimed_at = ?,
				claim_expires_at = ?,
				last_attempt_at = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ? AND status = 'active'
			)
				AND (
					state = 'idle'
					OR (state = 'running' AND claim_expires_at <= ?)
				)
		`).bind(
			leaseToken,
			now,
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
			WITH due AS (
				SELECT state.connector_id, state.next_run_at
				FROM source_connector_state AS state
				WHERE state.state = 'idle' AND state.next_run_at <= ?

				UNION ALL

				SELECT state.connector_id, state.next_run_at
				FROM source_connector_state AS state
				WHERE state.state = 'queued'
					AND state.next_run_at <= ?
					AND state.claim_expires_at <= ?

				UNION ALL

				SELECT state.connector_id, state.next_run_at
				FROM source_connector_state AS state
				WHERE state.state = 'running'
					AND state.next_run_at <= ?
					AND state.claim_expires_at <= ?
			)
			SELECT connectors.connector_key AS source_id
			FROM due
			JOIN source_connectors AS connectors ON connectors.id = due.connector_id
			JOIN sources ON sources.id = connectors.source_id
			WHERE connectors.status = 'active' AND sources.status = 'active'
			ORDER BY due.next_run_at, connectors.connector_key
			LIMIT ?
		`).bind(now, now, now, now, now, limit).all<{ source_id: string }>();
		return result.results.map(({ source_id }) => source_id);
	}

	async claimForQueue(
		sourceId: string,
		queueToken: string,
		now: number,
		claimSeconds: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'queued',
				claim_token = ?,
				claimed_at = ?,
				claim_expires_at = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ? AND status = 'active'
			)
				AND next_run_at <= ?
				AND (
					state = 'idle'
					OR (state IN ('queued', 'running') AND claim_expires_at <= ?)
				)
		`).bind(
			queueToken,
			now,
			now + claimSeconds,
			now,
			sourceId,
			now,
			now,
		).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async releaseQueueClaim(sourceId: string, queueToken: string, now: number): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'idle',
				claim_token = NULL,
				claimed_at = NULL,
				claim_expires_at = NULL,
				next_run_at = MIN(next_run_at, ?),
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND state = 'queued' AND claim_token = ?
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
			UPDATE source_connector_state
			SET
				state = 'running',
				claim_token = ?,
				claimed_at = ?,
				claim_expires_at = ?,
				last_attempt_at = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ? AND status = 'active'
			)
				AND state = 'queued'
				AND claim_token = ?
				AND next_run_at <= ?
		`).bind(
			leaseToken,
			now,
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
		nextRunAt: number,
		claimExpiresAt: number,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'queued',
				next_run_at = ?,
				claim_token = ?,
				claimed_at = ?,
				claim_expires_at = ?,
				failure_count = failure_count + 1,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND state = 'running' AND claim_token = ?
		`).bind(
			nextRunAt,
			queueToken,
			now,
			claimExpiresAt,
			errorCode,
			errorMessage.slice(0, MAX_ERROR_LENGTH),
			now,
			sourceId,
			leaseToken,
		).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async reconcileDeadLetter(sourceId: string, queueToken: string, now: number): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'dead',
				claim_token = NULL,
				claimed_at = NULL,
				claim_expires_at = NULL,
				last_error_code = 'INGESTION_QUEUE_DEAD_LETTERED',
				last_error = COALESCE(last_error, 'Cloudflare Queue retries were exhausted'),
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND (
					(state = 'queued' AND claim_token = ?)
					OR (state = 'running' AND claim_expires_at <= ?)
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
		return this.finishFailure(
			sourceId,
			leaseToken,
			'blocked',
			null,
			errorCode,
			errorMessage,
			now,
		);
	}

	async recoverDeadSources(now: number, cooldownSeconds: number): Promise<number> {
		return this.recover('dead', now, cooldownSeconds, 'INGESTION_DLQ_RECOVERY');
	}

	async recoverBlockedSources(now: number, cooldownSeconds: number): Promise<number> {
		return this.recover('blocked', now, cooldownSeconds, 'INGESTION_BLOCKED_RECOVERY');
	}

	async listReadinessIssues(
		now: number,
		minimumStaleSeconds: number,
		pollMultiplier: number,
	): Promise<SourceReadinessIssue[]> {
		const result = await this.db.prepare(`${runtimeSelect()}
			WHERE connectors.status = 'active'
				AND sources.status = 'active'
				AND EXISTS (
					SELECT 1
					FROM source_routes AS routes
					JOIN destinations ON destinations.id = routes.destination_id
					WHERE routes.source_id = sources.id
						AND routes.status = 'active'
						AND destinations.status = 'active'
				)
			ORDER BY connectors.connector_key
		`).all<RuntimeRow>();

		return result.results.flatMap((row) => {
			const staleAfterSeconds = Math.max(
				minimumStaleSeconds,
				row.poll_every_seconds * pollMultiplier,
			);
			const status = runtimeStatus(row);
			const reason = readinessReason(status, row, now, staleAfterSeconds);
			return reason ? [{
				sourceId: row.source_id,
				status,
				lastSuccessAt: row.last_success_at,
				staleAfterSeconds,
				reason,
			}] : [];
		});
	}

	async countActiveSources(): Promise<number> {
		const row = await this.db.prepare(`
			SELECT COUNT(*) AS count
			FROM source_connectors AS connectors
			JOIN sources ON sources.id = connectors.source_id
			WHERE connectors.status = 'active' AND sources.status = 'active'
				AND EXISTS (
					SELECT 1
					FROM source_routes AS routes
					JOIN destinations ON destinations.id = routes.destination_id
					WHERE routes.source_id = sources.id
						AND routes.status = 'active'
						AND destinations.status = 'active'
				)
		`).first<{ count: number }>();
		return row?.count ?? 0;
	}

	async markSucceeded(
		sourceId: string,
		leaseToken: string,
		nextRunAt: number,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'idle',
				next_run_at = ?,
				claim_token = NULL,
				claimed_at = NULL,
				claim_expires_at = NULL,
				failure_count = 0,
				last_success_at = ?,
				last_error_code = NULL,
				last_error = NULL,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND state = 'running' AND claim_token = ?
		`).bind(nextRunAt, now, now, sourceId, leaseToken).run();
		return (result.meta.changes ?? 0) === 1;
	}

	async markFailed(
		sourceId: string,
		leaseToken: string,
		nextRunAt: number,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		return this.finishFailure(
			sourceId,
			leaseToken,
			'idle',
			nextRunAt,
			errorCode,
			errorMessage,
			now,
		);
	}

	async get(sourceId: string): Promise<SourceRuntimeState | null> {
		const row = await this.db.prepare(`${runtimeSelect()}
			WHERE connectors.connector_key = ?
		`).bind(sourceId).first<RuntimeRow>();
		return row ? mapState(row) : null;
	}

	private async finishFailure(
		sourceId: string,
		leaseToken: string,
		state: 'blocked' | 'idle',
		nextRunAt: number | null,
		errorCode: string,
		errorMessage: string,
		now: number,
	): Promise<boolean> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = ?,
				next_run_at = COALESCE(?, next_run_at),
				claim_token = NULL,
				claimed_at = NULL,
				claim_expires_at = NULL,
				failure_count = failure_count + 1,
				last_error_code = ?,
				last_error = ?,
				updated_at = ?
			WHERE connector_id = (
				SELECT id FROM source_connectors WHERE connector_key = ?
			)
				AND state = 'running' AND claim_token = ?
		`).bind(
			state,
			nextRunAt,
			errorCode,
			errorMessage.slice(0, MAX_ERROR_LENGTH),
			now,
			sourceId,
			leaseToken,
		).run();
		return (result.meta.changes ?? 0) === 1;
	}

	private async recover(
		state: 'blocked' | 'dead',
		now: number,
		cooldownSeconds: number,
		errorCode: string,
	): Promise<number> {
		const result = await this.db.prepare(`
			UPDATE source_connector_state
			SET
				state = 'idle',
				next_run_at = ?,
				last_error_code = ?,
				last_error = 'Retrying source after recovery cooldown',
				updated_at = ?
			WHERE state = ? AND updated_at <= ?
		`).bind(now, errorCode, now, state, now - cooldownSeconds).run();
		return result.meta.changes ?? 0;
	}
}

function runtimeSelect(): string {
	return `
		SELECT
			connectors.connector_key AS source_id,
			connectors.adapter_key,
			sources.identity_namespace,
			(
				SELECT destinations.destination_key
				FROM source_routes AS routes
				JOIN destinations ON destinations.id = routes.destination_id
				WHERE routes.source_id = sources.id
					AND routes.status = 'active'
					AND destinations.status = 'active'
				ORDER BY destinations.destination_key
				LIMIT 1
			) AS destination_key,
			connectors.poll_interval_seconds AS poll_every_seconds,
			state.state,
			state.next_run_at,
			state.claim_token,
			state.claimed_at,
			state.claim_expires_at,
			state.failure_count,
			state.last_attempt_at,
			state.last_success_at,
			state.last_error_code,
			state.last_error,
			state.created_at,
			state.updated_at
		FROM source_connector_state AS state
		JOIN source_connectors AS connectors ON connectors.id = state.connector_id
		JOIN sources ON sources.id = connectors.source_id
	`;
}

function runtimeStatus(row: RuntimeRow): SourceRuntimeStatus {
	if (row.state === 'idle' && row.last_error_code) return 'backoff';
	return row.state;
}

function mapState(row: RuntimeRow): SourceRuntimeState {
	const queued = row.state === 'queued';
	const running = row.state === 'running';
	return {
		sourceId: row.source_id,
		adapterKey: row.adapter_key,
		identityNamespace: row.identity_namespace,
		destinationKey: row.destination_key,
		pollEverySeconds: row.poll_every_seconds,
		status: runtimeStatus(row),
		nextPollAt: row.next_run_at,
		queueToken: queued ? row.claim_token : null,
		queuedAt: queued ? row.claimed_at : null,
		queueExpiresAt: queued ? row.claim_expires_at : null,
		leaseToken: running ? row.claim_token : null,
		leaseExpiresAt: running ? row.claim_expires_at : null,
		consecutiveFailures: row.failure_count,
		lastAttemptAt: row.last_attempt_at,
		lastSuccessAt: row.last_success_at,
		lastErrorCode: row.last_error_code,
		lastError: row.last_error,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function readinessReason(
	status: SourceRuntimeStatus,
	row: RuntimeRow,
	now: number,
	staleAfterSeconds: number,
): SourceReadinessIssue['reason'] | null {
	if (status === 'blocked') return 'blocked';
	if (status === 'dead') return 'dead';
	if (row.last_success_at === null) {
		return now - row.created_at > staleAfterSeconds ? 'never_succeeded' : null;
	}
	return now - row.last_success_at > staleAfterSeconds ? 'stale' : null;
}
