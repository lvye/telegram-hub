import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

if (isMainModule()) {
	const result = await smokeHealth({
		baseUrl: requiredEnv('WORKER_BASE_URL'),
		expectedVersionTag: requiredEnv('EXPECTED_VERSION_TAG'),
	});
	console.info(JSON.stringify({
		event: 'deployment_smoke_succeeded',
		attempt: result.attempt,
		activeSources: result.activeSources,
		versionId: result.versionId,
		versionTag: result.versionTag,
	}));
}

export async function smokeHealth({
	baseUrl,
	expectedVersionTag,
	fetchImpl = fetch,
	delayImpl = delay,
	logger = console,
	maxAttempts = 12,
}) {
	const healthUrl = new URL('/health', baseUrl);
	const readinessUrl = new URL('/health/ready', baseUrl);
	let lastFailure = 'smoke test did not run';
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const [health, readiness] = await Promise.all([
				fetchJson(fetchImpl, healthUrl),
				fetchJson(fetchImpl, readinessUrl),
			]);
			const valid = health.response.ok
				&& health.payload?.service === 'telegram-hub'
				&& health.payload?.status === 'ok'
				&& typeof health.payload?.versionId === 'string'
				&& health.payload.versionId.length > 0
				&& health.payload?.versionTag === expectedVersionTag
				&& readiness.response.ok
				&& readiness.payload?.service === 'telegram-hub'
				&& readiness.payload?.status === 'ready'
				&& readiness.payload?.activeSources > 0
				&& readiness.payload?.versionTag === expectedVersionTag;

			if (valid) {
				return {
					attempt,
					activeSources: readiness.payload.activeSources,
					versionId: health.payload.versionId,
					versionTag: health.payload.versionTag,
				};
			}

			lastFailure = JSON.stringify({
				health: { status: health.response.status, payload: health.payload },
				readiness: { status: readiness.response.status, payload: readiness.payload },
			});
		} catch (error) {
			lastFailure = error instanceof Error ? error.message : String(error);
		}

		logger.warn(JSON.stringify({
			event: 'deployment_smoke_retrying',
			attempt,
			lastFailure,
		}));
		if (attempt < maxAttempts) await delayImpl(5_000);
	}

	throw new Error(`Deployment smoke test failed after ${maxAttempts} attempts: ${lastFailure}`);
}

async function fetchJson(fetchImpl, url) {
	const response = await fetchImpl(url, {
		headers: { 'cache-control': 'no-cache' },
		signal: AbortSignal.timeout(10_000),
	});
	return { response, payload: await response.json() };
}

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function isMainModule() {
	return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
