/** Names seen in mail that the Encoding Standard does not list. */
const ALIASES: Readonly<Record<string, string>> = {
	'us-ascii': 'windows-1252',
	ascii: 'windows-1252',
	'ansi_x3.4-1968': 'windows-1252',
	utf8: 'utf-8',
	'utf-7': 'utf-8',
	cp1252: 'windows-1252',
	'x-sjis': 'shift_jis',
	'ks_c_5601-1987': 'euc-kr',
};

/**
 * The `TextDecoder` label for a MIME charset, or `undefined` when the
 * platform knows no such charset. US-ASCII is read as windows-1252, as
 * browsers do: real mail labelled ASCII often carries 8-bit bytes.
 */
export function charsetLabel(charset: string): string | undefined {
	const name = charset.trim().toLowerCase();
	const label = ALIASES[name] ?? name;
	try {
		return new TextDecoder(label).encoding;
	} catch {
		return undefined;
	}
}

/**
 * Decodes bytes in a MIME charset. An unknown charset is read as UTF-8 when
 * the bytes are valid UTF-8, and as windows-1252 otherwise, so a message
 * with a wrong label still reads; malformed bytes become U+FFFD.
 */
export function decodeCharset(bytes: Uint8Array, charset = 'utf-8'): string {
	const label = charsetLabel(charset);
	if (label !== undefined) return new TextDecoder(label).decode(bytes);
	return decodeUnlabelled(bytes);
}

/** UTF-8 when the bytes are valid UTF-8, windows-1252 when they are not. */
export function decodeUnlabelled(bytes: Uint8Array): string {
	try {
		return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return new TextDecoder('windows-1252').decode(bytes);
	}
}
