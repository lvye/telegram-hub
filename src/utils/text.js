// HTML 实体解码
export function decodeHtmlEntities(text) {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&nbsp;/g, ' ')
		.replace(/&#39;/g, "'");
}

// 转义 HTML 特殊字符
export function escapeHTML(text) {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

// 清理文本
export function cleanText(text) {
	return text
		.replace(/\s+/g, ' ')
		.replace(/\n\s*\n/g, '\n')
		.trim();
}

// 截断文本
export function truncateText(text, maxLength) {
	if (text.length <= maxLength) return text;

	const truncated = text.substring(0, maxLength);
	const lastNewLine = truncated.lastIndexOf('\n');

	if (lastNewLine > maxLength * 0.8) {
		return truncated.substring(0, lastNewLine) + '...';
	}
	return truncated + '...';
}
