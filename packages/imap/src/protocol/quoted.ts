/**
 * The inside of a quoted string (RFC 9051 §9) that starts at `at`, just
 * past its opening quote: its value, and where reading goes on, past the
 * closing quote. Only `"` and `\\` are escaped; a CR or no closing quote
 * is refused through `fail`.
 */
export function readQuoted(
	text: string,
	at: number,
	fail: (message: string) => never,
): { value: string; next: number } {
	let out = '';
	let start = at;
	for (;;) {
		const char = text[at];
		if (char === undefined) fail('Unterminated quoted string');
		if (char === '\r') fail('A quoted string cannot hold a CR');
		if (char === '"') break;
		if (char === '\\') {
			const next = text[at + 1];
			if (next !== '"' && next !== '\\') {
				fail('A quoted string escapes only " and \\');
			}
			out += text.slice(start, at) + next;
			at += 2;
			start = at;
			continue;
		}
		at++;
	}
	return { value: out + text.slice(start, at), next: at + 1 };
}
