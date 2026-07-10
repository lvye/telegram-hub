import { XMLParser } from '../utils/xml-parser';
import { decodeHtmlEntities, truncateText } from '../utils/text';
import type { ParsedFeedItem } from './types';

export function itHomeParser(content: string): ParsedFeedItem[] {
    try {
        const baseItems = XMLParser.parseRSS(content);

		return baseItems.map(item => {
			const processedDescription = processDescription(item.description);

			return {
				...item,
				description: processedDescription,
			};
        });
	} catch (error) {
		throw new Error('Failed to parse IT Home feed', { cause: error });
	}
}

function processDescription(description: string): string {
    if (!description) return '';

    let processed = decodeHtmlEntities(description);

    // IT之家特定的处理
    processed = processed.replace(/IT之家\s\d+\s月\s\d+\s日消息，/g, '');

    // 移除图片和表格
    processed = processed.replace(/<img[^>]*>/g, '');
    processed = processed.replace(
        /<table[^>]*>(.*?)<\/table>/gs,
		(_match, tableContent: string) => formatTable(tableContent)
    );

    // 处理列表
    processed = processed.replace(/<li[^>]*>/g, "• ");
    processed = processed.replace(/<\/li>/g, '\n');

    // 处理段落和换行
    processed = processed.replace(/<\/p>/g, '\n\n'); // 段落之间添加两行间隔
    processed = processed.replace(/<br\s*\/?>/gi, '\n'); // 替换 <br> 为换行

    // 移除其余HTML标签
    processed = processed.replace(/<[^>]+>/g, '');

    // 清理多余的换行符
    processed = processed.replace(/\n{3,}/g, '\n\n').trim(); // 确保最多两行间隔

    // 限制长度
    return truncateText(processed, 400);
}

function formatTable(tableContent: string): string {
    const rows = tableContent.match(/<tr[^>]*>(.*?)<\/tr>/gs) || [];
    return rows.map(row => {
        const cells = row.match(/<t[dh][^>]*>(.*?)<\/t[dh]>/g) || [];
        return cells
            .map(cell => cell.replace(/<[^>]+>/g, '').trim())
            .join(' | ');
    }).join('\n');
}
