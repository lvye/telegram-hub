const NAMED_HTML_ENTITIES: Record<string, string> = {
	amp: '&',
	apos: "'",
	gt: '>',
	lt: '<',
	nbsp: ' ',
	quot: '"',
};

// Decode exactly one entity layer. A single regex pass is intentional:
// `&amp;gt;` represents the literal text `&gt;`, not `>`.
export function decodeHtmlEntities(text: string): string {
	return text.replace(
		/&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
		(match, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
			if (name) return NAMED_HTML_ENTITIES[name.toLowerCase()] ?? match;

			const codePoint = Number.parseInt(decimal ?? hexadecimal ?? '', decimal ? 10 : 16);
			if (
				!Number.isInteger(codePoint)
				|| codePoint < 0
				|| codePoint > 0x10ffff
				|| (codePoint >= 0xd800 && codePoint <= 0xdfff)
			) return match;

			return String.fromCodePoint(codePoint);
		},
	);
}
