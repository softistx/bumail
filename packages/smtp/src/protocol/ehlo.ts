/**
 * The extensions an EHLO reply names (RFC 5321 §4.1.1.1): every line after
 * the first is a keyword, then its parameters. Keywords in upper case,
 * parameters as written, spaces around them dropped.
 */
export function parseEhlo(
	lines: readonly string[],
): ReadonlyMap<string, string> {
	const extensions = new Map<string, string>();
	for (const line of lines.slice(1)) {
		const text = line.trim();
		const space = text.indexOf(' ');
		const keyword = (space < 0 ? text : text.slice(0, space)).toUpperCase();
		if (keyword === '') continue;
		extensions.set(keyword, space < 0 ? '' : text.slice(space + 1).trim());
	}
	return extensions;
}
