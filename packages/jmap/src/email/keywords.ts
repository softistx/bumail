/** IMAP system flags as JMAP keywords (RFC 8621 §4.1.1); `\Deleted` has none. */
const SYSTEM: Readonly<Record<string, string>> = {
	'\\Seen': '$seen',
	'\\Answered': '$answered',
	'\\Flagged': '$flagged',
	'\\Draft': '$draft',
};

const FLAGS: Readonly<Record<string, string>> = Object.fromEntries(
	Object.entries(SYSTEM).map(([flag, keyword]) => [keyword, flag]),
);

/** A keyword (RFC 8621 §4.1.1): printable ASCII but `( ) { ] % * " \`, 255 at most. */
const KEYWORD = /^[!#$&'+,\-./0-9:;<=>?@A-Z[^_`a-z|}~]{1,255}$/;

export const isKeyword = (value: unknown): value is string =>
	typeof value === 'string' && KEYWORD.test(value);

/** A message's flags as JMAP keywords; `\Deleted` is not one (RFC 8621 §4.1.1). */
export function keywordsOf(flags: readonly string[]): Record<string, true> {
	const keywords: Record<string, true> = {};
	for (const flag of flags) {
		if (flag.startsWith('\\')) {
			const keyword = SYSTEM[flag];
			if (keyword !== undefined) keywords[keyword] = true;
		} else {
			keywords[flag] = true;
		}
	}
	return keywords;
}

/** The flag a store keeps for a keyword: `$seen` is `\Seen`, any other lowercased. */
export function flagOf(keyword: string): string {
	const lower = keyword.toLowerCase();
	return FLAGS[lower] ?? lower;
}
