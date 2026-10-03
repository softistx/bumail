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

/**
 * A message's flags as JMAP keywords, each lowercased: keywords compare
 * without case and a server returns them in lowercase (RFC 8621 §4.1.1), so
 * a stored `$Forwarded` is `$forwarded`, and two flags that differ only by
 * case are one keyword. `\Deleted` is not one.
 */
export function keywordsOf(flags: readonly string[]): Record<string, true> {
	const keywords: Record<string, true> = {};
	for (const flag of flags) {
		if (flag.startsWith('\\')) {
			const keyword = SYSTEM[flag];
			if (keyword !== undefined) keywords[keyword] = true;
		} else {
			keywords[flag.toLowerCase()] = true;
		}
	}
	return keywords;
}

/** The flag a store keeps for a keyword: `$seen` is `\Seen`, any other lowercased. */
export function flagOf(keyword: string): string {
	const lower = keyword.toLowerCase();
	return FLAGS[lower] ?? lower;
}

/**
 * Whether a message's flags hold a flag, its case aside: a store may keep a
 * keyword in the case it was first written with (`$Forwarded`), while
 * `flagOf` gives it lowercased. System flags are stored in canonical case.
 */
export function hasFlag(flags: readonly string[], flag: string): boolean {
	const key = flag.toLowerCase();
	return flags.some((one) => one.toLowerCase() === key);
}

/** The spellings a message's flags give to a flag, its case aside. */
export function storedSpellings(
	flags: readonly string[],
	flag: string,
): string[] {
	const key = flag.toLowerCase();
	return flags.filter((one) => one.toLowerCase() === key);
}

/**
 * Every stored flag `keywordsOf` shows as a system flag's keyword: the flag
 * itself and, kept as an ordinary keyword beside it, `$seen` in any case (an
 * IMAP client may store `$Seen`). A filter matches either, and a remove
 * takes both, or the email would stay `$seen` for good.
 */
export function shownAs(flags: readonly string[], flag: string): string[] {
	const keyword = SYSTEM[flag];
	const spellings = storedSpellings(flags, flag);
	return keyword === undefined
		? spellings
		: [...spellings, ...storedSpellings(flags, keyword)];
}
