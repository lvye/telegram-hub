export class XMLParser {
    // 基础 RSS 解析
    static parseRSS(content) {
        try {
            const items = [];
            const itemRegex = /<item>([\s\S]*?)<\/item>/g;

            let match;
            while ((match = itemRegex.exec(content)) !== null) {
                const itemContent = match[1];
                const baseItem = this.parseBaseItem(itemContent);
                if (baseItem) {
                    // 保存原始内容以便后续解析
                    baseItem.rawContent = itemContent;
                    items.push(baseItem);
                }
            }

            if (items.length === 0) {
                throw new Error('No items found in RSS feed');
            }

            return items;
        } catch (error) {
            throw new Error(`Failed to parse RSS feed: ${error.message}`);
        }
    }

    // 解析基本的 RSS 项目字段
    static parseBaseItem(itemContent) {
        return {
            guid: this.getTagContent(itemContent, 'guid') ||
                this.getTagContent(itemContent, 'link'),
            title: this.removeCDATA(this.getTagContent(itemContent, 'title')),
            description: this.getTagContent(itemContent, 'description'),
            link: this.getTagContent(itemContent, 'link'),
            pubDate: this.parseDate(this.getTagContent(itemContent, 'pubDate'))
        };
    }

    // 提取标签内容
    static getTagContent(text, tag) {
        // 首先尝试精确匹配
        let regex = new RegExp(`<${tag}[^>]*>(.*?)<\/${tag}>`, 's');
        let match = text.match(regex);

        if (match) {
            return match[1].trim();
        }

        // 如果是命名空间标签，尝试匹配任何命名空间
        if (tag.includes(':')) {
            const tagName = tag.split(':')[1];
            regex = new RegExp(`<[^:]*:${tagName}[^>]*>(.*?)<\/[^:]*:${tagName}>`, 's');
            match = text.match(regex);
            if (match) {
                return match[1].trim();
            }
        }

        return '';
    }

    // 解析日期
    static parseDate(dateStr) {
        return dateStr ? new Date(dateStr).toISOString() : null;
    }

    // HTML 实体解码
    static decodeHtmlEntities(text) {
        return text
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&nbsp;/g, ' ')
            .replace(/&#39;/g, "'");
    }

    // 清理文本
    static cleanText(text) {
        return text
            .replace(/\s+/g, ' ')
            .replace(/\n\s*\n/g, '\n')
            .trim();
    }

    // 截断文本
    static truncateText(text, maxLength) {
        if (text.length <= maxLength) return text;

        const truncated = text.substring(0, maxLength);
        const lastNewLine = truncated.lastIndexOf('\n');

        if (lastNewLine > maxLength * 0.8) {
            return truncated.substring(0, lastNewLine) + '...';
        }
        return truncated + '...';
    }

    // 转义 HTML 特殊字符
    static escapeHTML(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    static removeCDATA(text) {
        return text.replace(/<!\[CDATA\[(.*?)\]\]>/gs, '$1');
    }
}