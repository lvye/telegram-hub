import assert from 'node:assert/strict';
import test from 'node:test';
import { smokeHealth } from './smoke-health.mjs';

const HEALTHY_PAYLOAD = {
	service: 'telegram-hub',
	status: 'ok',
	versionId: 'version-id',
	versionTag: 'expected-sha',
};

test('accepts the deployed version tag', async () => {
	const result = await smokeHealth({
		baseUrl: 'https://worker.example',
		expectedVersionTag: 'expected-sha',
		fetchImpl: async () => Response.json(HEALTHY_PAYLOAD),
		delayImpl: async () => undefined,
		logger: silentLogger(),
	});

	assert.deepEqual(result, {
		attempt: 1,
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
		fetchImpl: async () => {
			calls += 1;
			return Response.json({
				...HEALTHY_PAYLOAD,
				versionTag: calls === 1 ? 'previous-sha' : 'expected-sha',
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
		fetchImpl: async () => Response.json({
			...HEALTHY_PAYLOAD,
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
