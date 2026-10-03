/**
 * Client text as it may be repeated in an answer: control characters left
 * out and cut after `max` characters, `...` marking the cut, so an error
 * description never carries a client's whole input back.
 */
export function cut(text: unknown, max = 100): string {
	let clean = '';
	for (const char of String(text)) {
		const code = char.charCodeAt(0);
		if (code >= 0x20 && code !== 0x7f) clean += char;
		if (clean.length > max) break;
	}
	return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}

/** `JSON.stringify` of client text, cut first. */
export const quoted = (text: unknown, max = 100) =>
	JSON.stringify(cut(text, max));

/** An RFC 8620 §1.2 Id: 1 to 255 characters of the URL-safe base64 alphabet. */
export const ID = /^[A-Za-z0-9_-]{1,255}$/;

export const isId = (value: unknown): value is string =>
	typeof value === 'string' && ID.test(value);

/** A UTCDate (RFC 8620 §1.4): `2014-10-30T06:12:00Z`, fractions only when not zero. */
export function utcDate(date: Date): string {
	return date.toISOString().replace('.000Z', 'Z');
}
