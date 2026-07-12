export interface SourceHttpCacheEntry {
	etag: string | null;
	lastModified: string | null;
}

export interface SourceHttpCacheStore {
	getSourceHttpCache(sourceId: string): Promise<SourceHttpCacheEntry>;
	setSourceHttpCache(
		sourceId: string,
		entry: SourceHttpCacheEntry,
		updatedAt?: number,
	): Promise<void>;
}

export const EMPTY_SOURCE_HTTP_CACHE_ENTRY: SourceHttpCacheEntry = {
	etag: null,
	lastModified: null,
};
