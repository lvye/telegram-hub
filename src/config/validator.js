export function validateConfig(config) {
    const requiredFields = {
        rss: {
            sources: (val) => Array.isArray(val) && val.length > 0,
            updateInterval: (val) => typeof val === 'number' && val > 0,
            cleanupTime: (val) => typeof val === 'number' && val >= 0 && val < 24
        },
        telegram: {
            retryAttempts: (val) => typeof val === 'number' && val > 0,
            retryDelay: (val) => typeof val === 'number' && val > 0,
            rateLimitDelay: (val) => typeof val === 'number' && val > 0
        },
        database: {
            batchSize: (val) => typeof val === 'number' && val > 0
        }
    };

    validateFields(config, requiredFields);
    validateRSSSources(config.rss.sources);

    return config;
}

function validateFields(obj, schema, path = '') {
    for (const [key, validator] of Object.entries(schema)) {
        const value = obj[key];
        const currentPath = path ? `${path}.${key}` : key;

        if (value === undefined) {
            throw new Error(`Missing required field: ${currentPath}`);
        }

        if (typeof validator === 'function') {
            if (!validator(value)) {
                throw new Error(`Invalid value for ${currentPath}`);
            }
        } else if (typeof validator === 'object') {
            validateFields(value, validator, currentPath);
        }
    }
}

function validateRSSSources(sources) {
    const requiredSourceFields = {
        name: (val) => typeof val === 'string' && val.length > 0,
        url: (val) => typeof val === 'string' && val.startsWith('http'),
        parser: (val) => typeof val === 'string' && val.length > 0,
        chatId: (val) => typeof val === 'string' && val.length > 0,
        parseMode: (val) => ['HTML', 'Markdown'].includes(val)
    };

    sources.forEach((source, index) => {
        for (const [field, validator] of Object.entries(requiredSourceFields)) {
            if (!validator(source[field])) {
                throw new Error(
                    `Invalid ${field} in RSS source at index ${index}`
                );
            }
        }
    });
}