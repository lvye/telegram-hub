import { Logger } from './logger';

export class CustomError extends Error {
    constructor(message, code, metadata = {}) {
        super(message);
        this.name = 'CustomError';
        this.code = code;
        this.metadata = metadata;
    }
}

export function handleError(error, context) {
    const errorInfo = {
        message: error.message,
        code: error.code,
        context,
        metadata: error.metadata
    };

    if (error instanceof CustomError) {
        Logger.error(`${context}: ${error.message}`, errorInfo);
    } else {
        Logger.error(`Unexpected error in ${context}`, {
            ...errorInfo,
            stack: error.stack
        });
    }
}