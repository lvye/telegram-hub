import type { SourceConfig } from '../config';
import type { DeliveryLease } from '../domain/delivery';

export function formatTelegramMessage(delivery: DeliveryLease, source: SourceConfig): string {
	if (source.parser === 'twitter') {
		return [
			escapeHtml(delivery.title ?? ''),
			`${escapeHtml(delivery.author ?? 'Unknown User')}: ${formatLink(delivery.link, '查看原文')}`,
		].filter(Boolean).join('\n\n');
	}

	return [
		delivery.title ? `<b>${escapeHtml(delivery.title)}</b>` : '',
		delivery.description ? escapeHtml(delivery.description) : '',
		formatLink(delivery.link, '阅读更多'),
	].filter(Boolean).join('\n\n');
}

function formatLink(link: string | null, label: string): string {
	return link ? `<a href="${escapeAttribute(link)}">${escapeHtml(label)}</a>` : '';
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
