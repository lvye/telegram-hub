import type { AppConfig } from '../config';
import type { SourceReadinessIssue } from '../persistence/source-runtime-state-repository';
import { SourceRuntimeStateRepository } from '../persistence/source-runtime-state-repository';

export interface ReadinessSnapshot {
	status: 'not_ready' | 'ready';
	activeSources: number;
	issues: SourceReadinessIssue[];
}

export async function sourceReadiness(
	env: Env,
	config: AppConfig,
	now = Math.floor(Date.now() / 1_000),
): Promise<ReadinessSnapshot> {
	const repository = new SourceRuntimeStateRepository(env.DB);
	const [activeSources, issues] = await Promise.all([
		repository.countActiveSources(),
		repository.listReadinessIssues(
			now,
			config.ingestion.readinessMinimumSeconds,
			config.ingestion.readinessPollMultiplier,
		),
	]);
	return {
		status: activeSources > 0 && issues.length === 0 ? 'ready' : 'not_ready',
		activeSources,
		issues: activeSources === 0 ? [{
			sourceId: '*',
			status: 'blocked',
			lastSuccessAt: null,
			staleAfterSeconds: 0,
			reason: 'never_succeeded',
		}] : issues,
	};
}

export async function logSourceReadiness(
	env: Env,
	config: AppConfig,
	now: number,
): Promise<ReadinessSnapshot> {
	const snapshot = await sourceReadiness(env, config, now);
	if (snapshot.status === 'not_ready') {
		console.error({
			event: 'source_readiness_failed',
			activeSources: snapshot.activeSources,
			issues: snapshot.issues,
		});
	}
	return snapshot;
}
