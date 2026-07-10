import { XMLParser } from '../utils/xml-parser';
import { decodeHtmlEntities, cleanText, truncateText } from '../utils/text';
import type { ParsedFeedItem } from './types';

export function twitterParser(content: string): ParsedFeedItem[] {
    try {
        const baseItems = XMLParser.parseRSS(content);

        return baseItems.map(item => {
            const processedDescription = processDescription(item.description);
            const username = extractUsername(item.rawContent || '');

            // 只从 media:content 标签提取图片
			const rawImageUrl = extractImageUrl(item.rawContent || '');
            const imageUrl = validateAndCleanImageUrl(rawImageUrl, item.guid);

			return {
				...item,
				description: processedDescription,
				author: username,
				image: imageUrl,
			};
        });
	} catch (error) {
		throw new Error('Failed to parse Twitter feed', { cause: error });
	}
}

function extractImageUrl(itemContent: string): string | null {
    // 只处理 media:content 标签中的图片
    const mediaContentRegex = /<media:content([^>]*)\/?>/gi;

    let match;
    while ((match = mediaContentRegex.exec(itemContent)) !== null) {
        const attributes = XMLParser.parseAttributes(match[1]);

        // 检查是否为图片类型
        if (attributes.medium === 'image' && attributes.url) {
            return attributes.url;
        }
    }

    return null;
}

function validateAndCleanImageUrl(url: string | null, itemGuid: string): string | null {
    if (!url) return null;

    try {
        // 解码 HTML 实体
        let cleanUrl = decodeHtmlEntities(url);

        // 移除可能的前后空白字符
        cleanUrl = cleanUrl.trim();

        // 验证 URL 格式
		new URL(cleanUrl);

        // 检查是否为有效的图片 URL
        if (!isValidImageUrl(cleanUrl)) {
			console.info({
				event: 'invalid_image_url_format',
				itemId: itemGuid,
				originalUrl: url,
				cleanUrl
            });
            return null;
        }

        // 验证 URL 字符
        if (!isValidUrlCharacters(cleanUrl)) {
			console.info({
				event: 'invalid_image_url_characters',
				itemId: itemGuid,
				originalUrl: url,
				cleanUrl
            });
            return null;
        }

		console.info({
			event: 'image_url_extracted',
			itemId: itemGuid,
			url: cleanUrl
        });

        return cleanUrl;

    } catch (error) {
		console.error({
			event: 'image_url_validation_failed',
			itemId: itemGuid,
			originalUrl: url,
			error: error instanceof Error ? error.message : String(error)
        });
        return null;
    }
}

function isValidImageUrl(url: string): boolean {
    if (!url) return false;

    // Twitter 媒体链接
    if (url.includes('pbs.twimg.com/media/')) {
        return true;
    }

    // 标准图片扩展名
    const imagePattern = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;
    return imagePattern.test(url);
}

function isValidUrlCharacters(url: string): boolean {
    // 检查 URL 是否只包含有效字符
    // Telegram 对 URL 字符有严格要求
    const validUrlPattern = /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
    return validUrlPattern.test(url);
}

// 其他函数保持原样
function extractUsername(itemContent: string): string {
    // 尝试多种方式提取用户名

    // 方法1: 提取 dc:creator 标签内容
    let username = XMLParser.getTagContent(itemContent, 'dc:creator');
    if (username) {
        username = XMLParser.removeCDATA(username).trim();
        if (username) return username;
    }

    // 方法2: 尝试不带命名空间的 creator 标签
    username = XMLParser.getTagContent(itemContent, 'creator');
    if (username) {
        username = XMLParser.removeCDATA(username).trim();
        if (username) return username;
    }

    // 方法3: 从描述中提取用户名（Twitter 格式）
    const description = XMLParser.getTagContent(itemContent, 'description');
    if (description) {
        const match = description.match(/—\s*([^(]+)\s*\(/);
        if (match) {
            return match[1].trim();
        }
    }

    return 'Unknown User';
}

function processDescription(description: string): string {
    if (!description) return '';

    let processed = decodeHtmlEntities(description);
    processed = processed.replace(/<[^>]+>/g, '');
    processed = cleanText(processed);

    return truncateText(processed, 400);
}
