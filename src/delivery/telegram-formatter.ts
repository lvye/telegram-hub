import type { DeliveryDestinationConfig } from '../config';
import type { DeliveryLease } from '../domain/delivery';
import { safeHttpUrl } from '../utils/http-url';
import { renderHtmlForTelegram } from './telegram-html-serializer';
import {
	ARTICLE_DESCRIPTION_MAX_LENGTH,
	limitTelegramHtml,
	TELEGRAM_CAPTION_MAX_LENGTH,
	TELEGRAM_MESSAGE_MAX_LENGTH,
} from './telegram-message-limits';

export function formatTelegramMessage(
	delivery: DeliveryLease,
	destination: DeliveryDestinationConfig,
): string {
	const maxLength = delivery.imageUrl ? TELEGRAM_CAPTION_MAX_LENGTH : TELEGRAM_MESSAGE_MAX_LENGTH;
	if (destination.messageFormat === 'twitter') {
		return withSourceLink(
			escapeHtml(delivery.title ?? ''),
			formatLink(delivery.link, '查看原文'),
			maxLength,
			`${escapeHtml(delivery.author ?? 'Unknown User')}:`,
		);
	}

	return withSourceLink([
		delivery.title ? `<b>${escapeHtml(delivery.title)}</b>` : '',
		delivery.formattedDescription
			? renderHtmlForTelegram(delivery.formattedDescription, {
				maxTextLength: ARTICLE_DESCRIPTION_MAX_LENGTH,
				preserveLineBreaks: true,
			}).html
			: delivery.description ? escapeHtml(delivery.description) : '',
	].filter(Boolean).join('\n\n'), formatLink(delivery.link, '阅读更多'), maxLength);
}

function withSourceLink(body: string, link: string, maxLength: number, author = ''): string {
	const linkLength = renderHtmlForTelegram(link).text.length;
	const footer = limitTelegramHtml(author, maxLength - linkLength - 2) + (author && link ? ' ' : '') + link;
	const footerLength = [...renderHtmlForTelegram(footer, { preserveLineBreaks: true }).text].length;
	const limitedBody = limitTelegramHtml(body, maxLength - footerLength - (footer ? 2 : 0));
	return [limitedBody, footer].filter(Boolean).join('\n\n');
}

function formatLink(link: string | null, label: string): string {
	const safeLink = safeHttpUrl(link);
	return safeLink ? `<a href="${escapeAttribute(safeLink)}">${escapeHtml(label)}</a>` : '';
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
	return escapeHtml(value)
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}
