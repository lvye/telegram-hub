import type { DeliveryDestinationConfig } from '../config';
import type { DeliveryLease } from '../domain/delivery';
import { renderHtmlForTelegram } from './telegram-html-serializer';

export function formatTelegramMessage(
	delivery: DeliveryLease,
	destination: DeliveryDestinationConfig,
): string {
	if (destination.messageFormat === 'twitter') {
		return [
			escapeHtml(delivery.title ?? ''),
			`${escapeHtml(delivery.author ?? 'Unknown User')}: ${formatLink(delivery.link, '查看原文')}`,
		].filter(Boolean).join('\n\n');
	}

	return [
		delivery.title ? `<b>${escapeHtml(delivery.title)}</b>` : '',
		delivery.formattedDescription
			? renderHtmlForTelegram(delivery.formattedDescription, { maxTextLength: 400 }).html
			: delivery.description ? escapeHtml(delivery.description) : '',
		formatLink(delivery.link, '阅读更多'),
	].filter(Boolean).join('\n\n');
}

function formatLink(link: string | null, label: string): string {
	const safeLink = safeHttpUrl(link);
	return safeLink ? `<a href="${escapeAttribute(safeLink)}">${escapeHtml(label)}</a>` : '';
}

function safeHttpUrl(value: string | null): string | null {
	if (!value?.trim()) return null;
	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? value.trim() : null;
	} catch {
		return null;
	}
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
