import { XMLParser } from '../utils/xml-parser';
import { CustomError } from '../utils/error-handler';

export function twitterParser(content) {
    try {
        const baseItems = XMLParser.parseRSS(content);

        return baseItems.map(item => {
            const processedDescription = processDescription(item.description);

            // 修复用户名获取逻辑
            const username = extractUsername(item.rawContent || '');

            return {
                ...item,
                description: processedDescription,
                message: formatMessage(
                    item.title,
                    item.link,
                    username
                )
            };
        });
    } catch (error) {
        throw new CustomError(
            'Failed to parse Twitter feed',
            'PARSER_ERROR',
            { content: content.substring(0, 100) }
        );
    }
}

function extractUsername(itemContent) {
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

function processDescription(description) {
    if (!description) return '';

    let processed = XMLParser.decodeHtmlEntities(description);
    processed = processed.replace(/<[^>]+>/g, '');
    processed = XMLParser.cleanText(processed);

    return XMLParser.truncateText(processed, 400);
}

function formatMessage(title, link, username) {
    return `${title}\n\n${username}: ${link}`;
}
