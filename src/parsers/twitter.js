import { XMLParser } from '../utils/xml-parser';
import { CustomError } from '../utils/error-handler';

export function twitterParser(content) {
    try {
        const baseItems = XMLParser.parseRSS(content);

        return baseItems.map(item => {
            const processedDescription = processDescription(item.description);

            return {
                ...item,
                description: processedDescription,
                message: formatMessage(
                    item.title,
                    item.link,
                    item['dc:creator'] || ''
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

function processDescription(description) {
    if (!description) return '';

    let processed = XMLParser.decodeHtmlEntities(description);
    processed = processed.replace(/<[^>]+>/g, '');
    processed = XMLParser.cleanText(processed);

    return XMLParser.truncateText(processed, 400);
}


function formatMessage(title, link, username) {
    return `${title}\n\n ${username}: ${link}`;
}