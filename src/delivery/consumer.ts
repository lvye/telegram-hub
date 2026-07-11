import { findDestination, type AppConfig } from '../config';
import type { DeliveryJob, DeliveryLease } from '../domain/delivery';
import { DeliveryRepository } from '../persistence/delivery-repository';
import { PermanentDeliveryError, RetryableDeliveryError } from './errors';
import { TelegramClient } from './telegram-client';
import { formatTelegramMessage } from './telegram-formatter';

const MAX_DELAY_SECONDS = 86_400;

export async function consumeDeliveryBatch(
	batch: MessageBatch<DeliveryJob>,
	env: Env,
	config: AppConfig,
): Promise<void> {
	const repository = new DeliveryRepository(env.DB);
	const telegram = new TelegramClient(
		requiredBinding(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
		config.telegram.requestTimeoutMs,
	);

	for (const message of batch.messages) {
		await consumeMessage(message, config, repository, telegram);
	}
}

export async function consumeDeadLetterBatch(
	batch: MessageBatch<DeliveryJob>,
	env: Env,
	config: AppConfig,
): Promise<void> {
	const repository = new DeliveryRepository(env.DB);

	for (const message of batch.messages) {
		if (!isDeliveryJob(message.body)) {
			console.error({ event: 'invalid_dead_letter_job', queueMessageId: message.id });
			message.ack();
			continue;
		}

		const now = currentUnixTime();
		const reconciled = await repository.reconcileDeadLetter(
			message.body.deliveryId,
			config.delivery.maxAttempts,
			now,
		);
		if (!reconciled) {
			const state = await repository.getState(message.body.deliveryId);
			if (state?.status === 'sending' && state.leaseExpiresAt && state.leaseExpiresAt > now) {
				const delaySeconds = clampDelay(state.leaseExpiresAt - now);
				console.warn({
					event: 'dead_letter_waiting_for_active_lease',
					deliveryId: message.body.deliveryId,
					queueMessageId: message.id,
					delaySeconds,
				});
				message.retry({ delaySeconds });
				continue;
			}

			// A terminal, blocked, or missing delivery makes this DLQ copy stale.
			message.ack();
			continue;
		}

		console.error({
			event: 'delivery_reconciled_from_dlq',
			deliveryId: message.body.deliveryId,
			queueMessageId: message.id,
			outcome: reconciled,
		});
		message.ack();
	}
}

async function consumeMessage(
	message: Message<DeliveryJob>,
	config: AppConfig,
	repository: DeliveryRepository,
	telegram: TelegramClient,
): Promise<void> {
	if (!isDeliveryJob(message.body)) {
		console.error({ event: 'invalid_delivery_job', queueMessageId: message.id });
		message.ack();
		return;
	}

	const now = currentUnixTime();
	const leaseToken = crypto.randomUUID();
	const lease = await repository.acquireLease(
		message.body.deliveryId,
		leaseToken,
		now,
		config.delivery.leaseSeconds,
		config.delivery.maxAttempts,
	);

	if (!lease) {
		await handleUnavailableDelivery(message, config, repository, now);
		return;
	}

	try {
		const result = await deliver(lease, config, telegram);
		const marked = await repository.markSent(
			lease.deliveryId,
			lease.leaseToken,
			result.messageId,
		);

		if (!marked) {
			throw new RetryableDeliveryError('Lost the delivery lease before marking sent', 'LEASE_LOST');
		}

		console.info({
			event: 'telegram_delivery_sent',
			deliveryId: lease.deliveryId,
			sourceKey: lease.sourceKey,
			attempt: lease.attemptCount,
		});
		message.ack();
	} catch (error) {
		await handleDeliveryFailure(message, config, repository, lease, error);
	}
}

async function deliver(
	lease: DeliveryLease,
	config: AppConfig,
	telegram: TelegramClient,
): Promise<{ messageId: string | null }> {
	const destination = findDestination(config, lease.destinationKey);
	if (!destination) {
		throw new PermanentDeliveryError(
			`Unknown destination: ${lease.destinationKey}`,
			'UNKNOWN_DESTINATION',
		);
	}

	const message = formatTelegramMessage(lease, destination);
	if (!message) {
		throw new PermanentDeliveryError('Telegram message is empty', 'EMPTY_MESSAGE');
	}

	if (lease.imageUrl) {
		try {
			return await telegram.sendPhoto(
				destination.chatId,
				lease.imageUrl,
				message,
				destination.parseMode,
			);
		} catch (error) {
			if (!(error instanceof PermanentDeliveryError)) throw error;

			console.warn({
				event: 'telegram_photo_fallback',
				deliveryId: lease.deliveryId,
				error: error.message,
			});
		}
	}

	return telegram.sendMessage(destination.chatId, message, destination.parseMode);
}

async function handleUnavailableDelivery(
	message: Message<DeliveryJob>,
	config: AppConfig,
	repository: DeliveryRepository,
	now: number,
): Promise<void> {
	const state = await repository.getState(message.body.deliveryId);

	if (!state || ['blocked', 'dead', 'sent'].includes(state.status)) {
		message.ack();
		return;
	}

	const notBefore = Math.max(state.availableAt, state.leaseExpiresAt ?? 0);
	if (notBefore > now) {
		message.retry({ delaySeconds: clampDelay(notBefore - now) });
		return;
	}

	if (state.attemptCount >= config.delivery.maxAttempts) {
		const marked = await repository.markDeadIfExhausted(
			message.body.deliveryId,
			config.delivery.maxAttempts,
			'DELIVERY_ATTEMPTS_EXHAUSTED',
			'Delivery attempts exhausted before a new lease could be acquired',
			now,
		);
		if (marked) message.ack();
		else message.retry({ delaySeconds: 30 });
		return;
	}

	message.retry({ delaySeconds: 30 });
}

async function handleDeliveryFailure(
	message: Message<DeliveryJob>,
	config: AppConfig,
	repository: DeliveryRepository,
	lease: DeliveryLease,
	error: unknown,
): Promise<void> {
	const messageText = errorMessage(error);
	const errorCode = deliveryErrorCode(error);
	const exhausted = lease.attemptCount >= config.delivery.maxAttempts;

	if (error instanceof PermanentDeliveryError || exhausted) {
		const marked = await repository.markDead(
			lease.deliveryId,
			lease.leaseToken,
			exhausted ? 'DELIVERY_ATTEMPTS_EXHAUSTED' : errorCode,
			messageText,
		);
		if (!marked) throw new Error('Failed to mark delivery as dead');
		console.error({
			event: 'telegram_delivery_dead',
			deliveryId: lease.deliveryId,
			attempt: lease.attemptCount,
			errorCode,
			error: messageText,
		});
		message.ack();
		return;
	}

	const requestedDelay = error instanceof RetryableDeliveryError
		? error.retryAfterSeconds
		: undefined;
	const delaySeconds = clampDelay(
		requestedDelay ?? 30 * 2 ** Math.max(0, lease.attemptCount - 1),
	);
	const released = await repository.releaseForQueueRetry(
		lease.deliveryId,
		lease.leaseToken,
		currentUnixTime() + delaySeconds,
		errorCode,
		messageText,
	);
	if (!released) throw new Error('Failed to release delivery lease for retry');
	console.error({
		event: 'telegram_delivery_retry',
		deliveryId: lease.deliveryId,
		attempt: lease.attemptCount,
		delaySeconds,
		errorCode,
		error: messageText,
	});
	message.retry({ delaySeconds });
}

function isDeliveryJob(value: unknown): value is DeliveryJob {
	if (!value || typeof value !== 'object') return false;
	const job = value as Partial<DeliveryJob>;
	return job.version === 1 && Number.isSafeInteger(job.deliveryId) && Number(job.deliveryId) > 0;
}

function clampDelay(value: number): number {
	return Math.min(MAX_DELAY_SECONDS, Math.max(1, Math.ceil(value)));
}

function deliveryErrorCode(error: unknown): string {
	return error instanceof RetryableDeliveryError || error instanceof PermanentDeliveryError
		? error.code
		: 'UNEXPECTED_DELIVERY_ERROR';
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function requiredBinding(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing required binding: ${name}`);
	return value.trim();
}

function currentUnixTime(): number {
	return Math.floor(Date.now() / 1_000);
}
