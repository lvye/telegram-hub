const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

// Decode exactly one entity layer. A single regex pass is intentional:
// `&amp;gt;` represents the literal text `&gt;`, not `>`.
export function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
		(match, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
			if (name) return NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match;

			const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
			if (
				!Number.isInteger(codePoint)
				|| codePoint < 0
				|| codePoint > 0x10ffff
				|| (codePoint >= 0xd800 && codePoint <= 0xdfff)
			) return match;

			return String.fromCodePoint(codePoint);
		},
	);
}

// 转义 HTML 特殊字符
export function escapeHTML(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// 清理文本
export function cleanText(text: string): string {
	return text
		.replace(/\s+/g, ' ')
		.replace(/\n\s*\n/g, '\n')
		.trim();
}

// 截断文本
export function truncateText(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;

	const truncated = text.substring(0, maxLength);
	const lastNewLine = truncated.lastIndexOf('\n');

	if (lastNewLine > maxLength * 0.8) {
		return truncated.substring(0, lastNewLine) + '...';
	}
	return truncated + '...';
}
