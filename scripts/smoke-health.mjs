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
	let lastFailure = 'smoke test did not run';
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			const response = await fetchImpl(healthUrl, {
				headers: { 'cache-control': 'no-cache' },
				signal: AbortSignal.timeout(10_000),
			});
			const payload = await response.json();
			const valid = response.ok
				&& payload?.service === 'telegram-hub'
				&& payload?.status === 'ok'
				&& typeof payload?.versionId === 'string'
				&& payload.versionId.length > 0
				&& payload?.versionTag === expectedVersionTag;

			if (valid) {
				return {
					attempt,
					versionId: payload.versionId,
					versionTag: payload.versionTag,
				};
			}

			lastFailure = `HTTP ${response.status}: ${JSON.stringify(payload)}`;
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

function requiredEnv(name) {
	const value = process.env[name]?.trim();
	if (!value) throw new Error(`Missing required environment variable: ${name}`);
	return value;
}

function isMainModule() {
	return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
