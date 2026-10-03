/** The most characters of the client's own text a response repeats. */
export const MAX_ECHO = 100;

/** Text without its control characters: what a response line may hold. */
export function plain(text: string): string {
	let out = '';
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code >= 0x20 && code !== 0x7f) out += text[i];
	}
	return out;
}

/**
 * Client text as a response repeats it: no control character — a CRLF in a
 * literal would end the line and forge the next response — and at most
 * `max` characters, the rest replaced by `...`.
 */
export function echo(text: string, max = MAX_ECHO): string {
	// Only the head is read: a 64 KiB name costs no more than a short one.
	const head = text.length > max * 4 ? text.slice(0, max * 4) : text;
	const clean = plain(head);
	if (clean.length <= max && head === text) return clean;
	// A cut between the halves of a surrogate pair would leave half a character.
	const code = clean.charCodeAt(max - 1);
	const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
	return `${clean.slice(0, end)}...`;
}
