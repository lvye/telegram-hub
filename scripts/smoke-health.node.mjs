import assert from 'node:assert/strict';
import test from 'node:test';
import { smokeHealth } from './smoke-health.mjs';

const HEALTHY_PAYLOAD = {
	service: 'telegram-hub',
	status: 'ok',
	versionId: 'version-id',
	versionTag: 'expected-sha',
};
const READY_PAYLOAD = {
	service: 'telegram-hub',
	status: 'ready',
	activeSources: 6,
	issues: [],
	versionId: 'version-id',
	versionTag: 'expected-sha',
};

test('accepts the deployed version tag', async () => {
	const result = await smokeHealth({
		baseUrl: 'https://worker.example',
		expectedVersionTag: 'expected-sha',
		fetchImpl: healthyFetch(),
		delayImpl: async () => undefined,
		logger: silentLogger(),
	});

	assert.deepEqual(result, {
		attempt: 1,
		activeSources: 6,
		versionId: 'version-id',
		versionTag: 'expected-sha',
	});
});

test('retries until traffic reaches the expected version', async () => {
	let calls = 0;
	const delays = [];
	const result = await smokeHealth({
		baseUrl: 'https://worker.example',
		expectedVersionTag: 'expected-sha',
		fetchImpl: async (url) => {
			const path = new URL(url).pathname;
			if (path === '/health') calls += 1;
			const versionTag = calls === 1 ? 'previous-sha' : 'expected-sha';
			return Response.json({
				...(path === '/health/ready' ? READY_PAYLOAD : HEALTHY_PAYLOAD),
				versionTag,
			});
		},
		delayImpl: async (milliseconds) => delays.push(milliseconds),
		logger: silentLogger(),
	});

	assert.equal(result.attempt, 2);
	assert.deepEqual(delays, [5_000]);
});

test('fails after the bounded retry budget', async () => {
	await assert.rejects(() => smokeHealth({
		baseUrl: 'https://worker.example',
		expectedVersionTag: 'expected-sha',
		fetchImpl: async (url) => Response.json({
			...(new URL(url).pathname === '/health/ready' ? READY_PAYLOAD : HEALTHY_PAYLOAD),
			versionTag: 'previous-sha',
		}),
		delayImpl: async () => undefined,
		logger: silentLogger(),
		maxAttempts: 2,
	}), /Deployment smoke test failed after 2 attempts/);
});

function silentLogger() {
	return { warn() {} };
}

function healthyFetch() {
	return async (url) => Response.json(
		new URL(url).pathname === '/health/ready' ? READY_PAYLOAD : HEALTHY_PAYLOAD,
	);
}
