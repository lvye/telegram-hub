export class SourceHttpError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly retryAfterSeconds: number | null,
	) {
		super(message);
		this.name = 'SourceHttpError';
	}
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
	if (!value) return null;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
	const retryAt = Date.parse(value);
	return Number.isFinite(retryAt)
		? Math.max(0, Math.ceil((retryAt - now) / 1_000))
		: null;
}
