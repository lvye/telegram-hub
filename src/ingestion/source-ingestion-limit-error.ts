export class SourceIngestionLimitError extends Error {
	constructor(
		readonly code: 'SOURCE_CANDIDATE_LIMIT_EXCEEDED' | 'SOURCE_IDENTITY_ALIAS_LIMIT_EXCEEDED',
		message: string,
	) {
		super(message);
		this.name = 'SourceIngestionLimitError';
	}

	static candidates(sourceId: string, count: number, limit: number): SourceIngestionLimitError {
		return new SourceIngestionLimitError(
			'SOURCE_CANDIDATE_LIMIT_EXCEEDED',
			`Source ${sourceId} returned ${count} candidates; limit is ${limit}`,
		);
	}

	static aliases(sourceId: string, count: number, limit: number): SourceIngestionLimitError {
		return new SourceIngestionLimitError(
			'SOURCE_IDENTITY_ALIAS_LIMIT_EXCEEDED',
			`Source ${sourceId} returned ${count} identity aliases; limit is ${limit}`,
		);
	}
}
