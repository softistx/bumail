const encoder = new TextEncoder();

/** RFC 1035 §3.3: a character-string is 255 octets at most. */
const MAX_STRING_BYTES = 255;

/** A zone-file quoted string: `"` and `\` escaped, a control character as `\DDD`. */
export function quoted(text: string): string {
	let out = '"';
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		if (char === '"' || char === '\\') out += `\\${char}`;
		else if (code < 0x20 || code === 0x7f) {
			out += `\\${String(code).padStart(3, '0')}`;
		} else out += char;
	}
	return `${out}"`;
}

/** `text` in pieces of 255 UTF-8 bytes at most, never cutting a character; one empty piece for `''`. */
export function pieces(text: string): string[] {
	const out: string[] = [];
	let piece = '';
	let size = 0;
	for (const char of text) {
		const bytes = encoder.encode(char).length;
		if (size + bytes > MAX_STRING_BYTES) {
			out.push(piece);
			piece = '';
			size = 0;
		}
		piece += char;
		size += bytes;
	}
	return piece === '' && out.length > 0 ? out : [...out, piece];
}
