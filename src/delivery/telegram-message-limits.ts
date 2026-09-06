import { renderHtmlForTelegram } from './telegram-html-serializer';

export const ARTICLE_DESCRIPTION_MAX_LENGTH = 160;
export const TELEGRAM_MESSAGE_MAX_LENGTH = 4_096;
export const TELEGRAM_CAPTION_MAX_LENGTH = 1_024;

/** Limits decoded text, including the ellipsis, while preserving valid HTML. */
export function limitTelegramHtml(input: string, maxLength: number): string {
	const rendered = renderHtmlForTelegram(input, { preserveLineBreaks: true });
	// Telegram limits count Unicode code points, not UTF-16 units or grapheme clusters.
	if (Array.from(rendered.text).length <= maxLength) return rendered.html;
	if (maxLength <= 0) return '';
	return renderHtmlForTelegram(rendered.html, {
		// The serializer appends an ellipsis outside its content budget.
		maxTextLength: maxLength - 1,
		preserveLineBreaks: true,
	}).html;
}
