import { CustomError } from '../utils/error-handler';
import { Logger } from '../utils/logger';

export class TelegramClient {
    constructor(token, config) {
        this.token = token;
        this.config = config;
    }

    async sendMessage(chatId, message, parseMode) {
        return this._makeRequest('sendMessage', {
            chat_id: chatId,
            text: message,
            parse_mode: parseMode
        });
    }

    async sendPhoto(chatId, photo, caption, parseMode) {
        return this._makeRequest('sendPhoto', {
            chat_id: chatId,
            photo,
            caption,
            parse_mode: parseMode
        });
    }

    async _makeRequest(method, payload, attempt = 1) {
        try {
            const url = `https://api.telegram.org/bot${this.token}/${method}`;
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            const result = await response.json();
            if (!result.ok) {
                if (result.error_code === 429 && result.parameters?.retry_after) {
                    const retryAfter = result.parameters.retry_after * 1000; // Convert to milliseconds
                    Logger.info(`Retrying after Telegram API limit: ${retryAfter}ms`, {
                        method,
                        chatId: payload.chat_id,
                    });

                    await new Promise(resolve => setTimeout(resolve, retryAfter));
                    return this._makeRequest(method, payload, attempt + 1);
                }

                throw new CustomError(
                    `Telegram API error: ${result.description}`,
                    'TELEGRAM_API_ERROR',
                    { method, result }
                );
            }

            Logger.info(`Telegram API request successful`, {
                method,
                chatId: payload.chat_id
            });

            return result;
        } catch (error) {
            if (attempt < this.config.retryAttempts) {
                Logger.info(`Retrying Telegram API request`, {
                    method,
                    attempt,
                    nextAttemptIn: this.config.retryDelay
                });

                await new Promise(resolve =>
                    setTimeout(resolve, this.config.retryDelay)
                );
                return this._makeRequest(method, payload, attempt + 1);
            }
            throw error;
        }
    }
}