import { itHomeParser } from './it-home';
import { twitterParser } from './twitter';
import { CustomError } from '../utils/error-handler';

const parsers = {
    'it-home': itHomeParser,
    'twitter': twitterParser
};

export function getParser(type) {
    const parser = parsers[type];
    if (!parser) {
        throw new CustomError(
            `Parser not found: ${type}`,
            'PARSER_NOT_FOUND'
        );
    }
    return parser;
}