export class RetryableDeliveryError extends Error {
	constructor(
		message: string,
		readonly code: string,
		readonly retryAfterSeconds?: number,
	) {
		super(message);
		this.name = 'RetryableDeliveryError';
	}
}

export class PermanentDeliveryError extends Error {
	constructor(message: string, readonly code: string) {
		super(message);
		this.name = 'PermanentDeliveryError';
	}
}
