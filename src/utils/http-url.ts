export function safeHttpUrl(value: string | null | undefined): string | null {
	if (!value?.trim()) return null;

	try {
		const url = new URL(value.trim());
		return url.protocol === 'http:' || url.protocol === 'https:' ? value.trim() : null;
	} catch {
		return null;
	}
}
