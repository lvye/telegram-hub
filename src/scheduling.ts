// Cron routing and stage cadence helpers. These live outside worker.ts because
// workerd treats every named export of the entry module as an entrypoint and
// refuses to start when one is not a handler.

export const UPDATE_CRON = '* * * * *';
export const CLEANUP_CRON = '0 4 * * *';

export type ScheduledTask = 'cleanup' | 'update';
export type SourceMaintenanceStage = 'readiness' | 'source_recovery' | 'source_sync';

const MINUTE_MS = 60_000;
const SOURCE_MAINTENANCE_INTERVAL_MINUTES = 15;
const SOURCE_SYNC_OFFSET_MINUTES = 1;
const SOURCE_RECOVERY_OFFSET_MINUTES = 6;
const READINESS_OFFSET_MINUTES = 11;
const DELIVERY_SWEEP_INTERVAL_MINUTES = 5;

export function scheduledTaskFor(cron: string): ScheduledTask {
	if (cron === UPDATE_CRON) return 'update';
	if (cron === CLEANUP_CRON) return 'cleanup';

	throw new Error(`Unsupported cron trigger: ${cron}`);
}

/**
 * Spreads heavier source maintenance across the 15-minute cycle. Normal due-source
 * dispatch still runs every minute, so existing 60-second poll intervals are unchanged.
 */
export function sourceMaintenanceStagesFor(scheduledTime: number): SourceMaintenanceStage[] {
	const minute = Math.floor(scheduledTime / MINUTE_MS);
	const offset = ((minute % SOURCE_MAINTENANCE_INTERVAL_MINUTES)
		+ SOURCE_MAINTENANCE_INTERVAL_MINUTES) % SOURCE_MAINTENANCE_INTERVAL_MINUTES;
	if (offset === SOURCE_SYNC_OFFSET_MINUTES) return ['source_sync'];
	if (offset === SOURCE_RECOVERY_OFFSET_MINUTES) return ['source_recovery'];
	if (offset === READINESS_OFFSET_MINUTES) return ['readiness'];
	return [];
}

/**
 * Ready deliveries are dispatched immediately after ingestion; the cron sweep
 * only exists to drain recovery paths (DLQ reconciliation, stale leases).
 */
export function shouldSweepDeliveries(scheduledTime: number): boolean {
	const minute = Math.floor(scheduledTime / MINUTE_MS);
	return ((minute % DELIVERY_SWEEP_INTERVAL_MINUTES) + DELIVERY_SWEEP_INTERVAL_MINUTES)
		% DELIVERY_SWEEP_INTERVAL_MINUTES === 0;
}
