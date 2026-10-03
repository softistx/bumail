/**
 * Text helpers shared by the parser, the canonicalisations and the signer.
 * Every trim here is an index scan, never an anchored regular expression:
 * `/[ \t]+$/` retries from each blank of a long inner run, which is
 * quadratic on hostile input. `String.trim` is not used either: it also
 * strips U+00A0, a byte of the value in a binary string.
 */

const SP = 0x20;
const TAB = 0x09;
const CR = 0x0d;
const LF = 0x0a;

/** White space (WSP): a space or a tab. */
function isWsp(code: number): boolean {
	return code === SP || code === TAB;
}

/** Folding white space as a tag list holds it: WSP, CR or LF. */
function isFws(code: number): boolean {
	return isWsp(code) || code === CR || code === LF;
}

function trimmed(
	text: string,
	blank: (code: number) => boolean,
	start: boolean,
): string {
	let from = 0;
	let to = text.length;
	if (start) while (from < to && blank(text.charCodeAt(from))) from++;
	while (to > from && blank(text.charCodeAt(to - 1))) to--;
	return from === 0 && to === text.length ? text : text.slice(from, to);
}

/** `text` without the spaces and tabs at its end. */
export function trimWspEnd(text: string): string {
	return trimmed(text, isWsp, false);
}

/** `text` without folding white space (space, tab, CR, LF) at either end. */
export function trimFws(text: string): string {
	return trimmed(text, isFws, true);
}

/** ASCII letters lowercased, and nothing else: no byte of a non-ASCII name changes. */
export function lowerAscii(text: string): string {
	return text.replace(/[A-Z]+/g, (upper) => upper.toLowerCase());
}

/** Bytes as a binary string: each byte one char, so nothing is decoded and nothing is lost. */
export function binary(bytes: Uint8Array): string {
	let text = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return text;
}

/** A binary string back to its bytes. */
export function bytesOf(text: string): Uint8Array {
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 0xff;
	return bytes;
}
