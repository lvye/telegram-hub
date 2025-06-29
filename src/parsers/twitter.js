import { XMLParser } from '../utils/xml-parser';
import { CustomError } from '../utils/error-handler';
import { Logger } from '../utils/logger';

export function twitterParser(content) {
    try {
        const baseItems = XMLParser.parseRSS(content);

        return baseItems.map(item => {
            const processedDescription = processDescription(item.description);
            const username = extractUsername(item.rawContent || '');

            // 只从 media:content 标签提取图片
            const rawImageUrl = extractImageUrl(item.rawContent || '', item.description || '');
            const imageUrl = validateAndCleanImageUrl(rawImageUrl, item.guid);

            return {
                ...item,
                description: processedDescription,
                image: imageUrl,
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

function extractImageUrl(itemContent, description) {
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

function validateAndCleanImageUrl(url, itemGuid) {
    if (!url) return null;

    try {
        // 解码 HTML 实体
        let cleanUrl = XMLParser.decodeHtmlEntities(url);

        // 移除可能的前后空白字符
        cleanUrl = cleanUrl.trim();

        // 验证 URL 格式
        const urlObj = new URL(cleanUrl);

        // 检查是否为有效的图片 URL
        if (!isValidImageUrl(cleanUrl)) {
            Logger.info(`Invalid image URL format for item ${itemGuid}`, {
                originalUrl: url,
                cleanUrl
            });
            return null;
        }

        // 验证 URL 字符
        if (!isValidUrlCharacters(cleanUrl)) {
            Logger.info(`Invalid characters in image URL for item ${itemGuid}`, {
                originalUrl: url,
                cleanUrl
            });
            return null;
        }

        Logger.info(`Valid image URL extracted for item ${itemGuid}`, {
            url: cleanUrl
        });

        return cleanUrl;

    } catch (error) {
        Logger.error(`Error validating image URL for item ${itemGuid}`, {
            originalUrl: url,
            error: error.message
        });
        return null;
    }
}

function isValidImageUrl(url) {
    if (!url) return false;

    // Twitter 媒体链接
    if (url.includes('pbs.twimg.com/media/')) {
        return true;
    }

    // 标准图片扩展名
    const imagePattern = /\.(jpg|jpeg|png|gif|webp)(\?|$)/i;
    return imagePattern.test(url);
}

function isValidUrlCharacters(url) {
    // 检查 URL 是否只包含有效字符
    // Telegram 对 URL 字符有严格要求
    const validUrlPattern = /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
    return validUrlPattern.test(url);
}

// 其他函数保持原样
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