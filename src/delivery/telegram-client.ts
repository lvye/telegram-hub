import { PermanentDeliveryError, RetryableDeliveryError } from './errors';

interface TelegramResponse {
	ok?: boolean;
	error_code?: number;
	description?: string;
	parameters?: {
		retry_after?: number;
	};
	result?: {
		message_id?: number;
	};
}

export interface TelegramSendResult {
	messageId: string | null;
}

export class TelegramClient {
	constructor(
		private readonly token: string,
		private readonly requestTimeoutMs: number,
	) {}

	async sendMessage(chatId: string, message: string, parseMode: string): Promise<TelegramSendResult> {
		return this.request('sendMessage', {
			chat_id: chatId,
			text: message,
			parse_mode: parseMode,
		});
	}

	async sendPhoto(
		chatId: string,
		photo: string,
		caption: string,
		parseMode: string,
	): Promise<TelegramSendResult> {
		return this.request('sendPhoto', {
			chat_id: chatId,
			photo,
			caption,
			parse_mode: parseMode,
		});
	}

	private async request(method: string, payload: Record<string, unknown>): Promise<TelegramSendResult> {
		let response: Response;

		try {
			response = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
				signal: AbortSignal.timeout(this.requestTimeoutMs),
			});
		} catch {
			// Telegram bot tokens are part of the request URL. Do not propagate a
			// runtime/network error that may echo that URL into structured logs.
			throw new RetryableDeliveryError('Telegram network request failed', 'TELEGRAM_NETWORK_ERROR');
		}

		const result = await parseTelegramResponse(response);
		if (!response.ok || !result.ok) {
			const description = result.description ?? `Telegram returned HTTP ${response.status}`;
			const errorCode = result.error_code ?? response.status;

			if (errorCode === 429) {
				throw new RetryableDeliveryError(
					description,
					'TELEGRAM_RATE_LIMITED',
					result.parameters?.retry_after,
				);
			}

			if (errorCode === 408 || errorCode >= 500) {
				throw new RetryableDeliveryError(description, `TELEGRAM_${errorCode}`);
			}

			throw new PermanentDeliveryError(description, `TELEGRAM_${errorCode}`);
		}

		return {
			messageId: result.result?.message_id?.toString() ?? null,
		};
	}
}

async function parseTelegramResponse(response: Response): Promise<TelegramResponse> {
	try {
		return await response.json<TelegramResponse>();
	} catch (error) {
		throw new RetryableDeliveryError(
			`Telegram returned an invalid JSON response: ${errorMessage(error)}`,
			'TELEGRAM_INVALID_RESPONSE',
		);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
