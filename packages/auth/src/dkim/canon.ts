import { lowerAscii, trimWspEnd } from './text';

/** A canonicalisation algorithm (RFC 6376 §3.4). */
export type Canonicalization = 'simple' | 'relaxed';

/** The header and body canonicalisation pair, as `c=` writes it. */
export type CanonicalizationPair = `${Canonicalization}/${Canonicalization}`;

/**
 * One header field canonicalised, CRLF included (§3.4.1, §3.4.2). `field`
 * is the field as it was written — name, colon, value and any folding,
 * its line breaks as CRLF — without its final CRLF.
 *
 * Relaxed lowercases the name (ASCII only, so no byte of a non-ASCII name
 * changes), unfolds, turns every run of white space into one space and
 * removes the white space around the colon and at the end.
 */
export function canonicalizeHeader(
	field: string,
	method: Canonicalization,
): string {
	if (method === 'simple') return `${field}\r\n`;
	const colon = field.indexOf(':');
	const name = lowerAscii(trimWspEnd(field.slice(0, colon)));
	const value = field
		.slice(colon + 1)
		.replace(/\r\n/g, '')
		.replace(/[ \t]+/g, ' ')
		.replace(/^ /, '')
		.replace(/ $/, '');
	return `${name}:${value}\r\n`;
}

/**
 * The DKIM-Signature field with the value of its `b=` tag deleted (§3.5:
 * "including all surrounding whitespace"), as it is hashed: the tag name,
 * its `=`, and nothing after it up to the next `;`.
 */
export function withoutSignatureValue(field: string): string {
	const colon = field.indexOf(':');
	const specs = field.slice(colon + 1).split(';');
	const emptied = specs.map((spec) => {
		const match = /^[ \t\r\n]*b[ \t\r\n]*=/.exec(spec);
		return match === null ? spec : match[0];
	});
	return `${field.slice(0, colon + 1)}${emptied.join(';')}`;
}
