/**
 * The header of a message on its way in, as bytes: split into its fields,
 * the fields that must not reach a reader taken out, and the server's own
 * put on top. Every field kept is kept byte for byte, so a DKIM signature
 * over it still verifies downstream.
 */

const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const TAB = 0x09;

/** The most header bytes read before the blank line; DKIM's own limit. */
export const MAX_HEADER_BYTES = 256 * 1024;

/**
 * Where the header ends in `bytes`: the index of the CRLF that is the
 * blank line, so `bytes.subarray(0, end)` is the fields, each ending in
 * CRLF, and the blank line and the body start at `end`; `-1` when there
 * is no blank line yet. `from` skips what an earlier call already looked
 * at.
 */
export function headerEnd(bytes: Uint8Array, from = 0): number {
	// A message with no field at all: the blank line comes first.
	if (bytes[0] === CR && bytes[1] === LF) return 0;
	for (let i = Math.max(from, 2); i + 1 < bytes.length; i++) {
		if (
			bytes[i] === CR &&
			bytes[i + 1] === LF &&
			bytes[i - 1] === LF &&
			bytes[i - 2] === CR
		) {
			return i;
		}
	}
	return -1;
}

/** Each field of `header` (fields only, each ending in CRLF), its folded lines included. */
export function splitFields(header: Uint8Array): Uint8Array[] {
	const fields: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i + 1 < header.length; i++) {
		if (header[i] !== CR || header[i + 1] !== LF) continue;
		const next = header[i + 2];
		// A line that starts with a space or a tab continues the field.
		if (next === SP || next === TAB) continue;
		fields.push(header.subarray(start, i + 2));
		start = i + 2;
	}
	if (start < header.length) fields.push(header.subarray(start));
	return fields;
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** The field's name, lower case; `''` when it has no colon. */
export function fieldName(field: Uint8Array): string {
	const colon = field.indexOf(0x3a);
	if (colon <= 0) return '';
	return decoder.decode(field.subarray(0, colon)).trim().toLowerCase();
}

/** Skips folding white space and comments (RFC 5322 §3.2.2) from `at`. */
function skipCfws(text: string, at: number): number {
	let i = at;
	for (;;) {
		while (i < text.length && /[ \t\r\n]/.test(text[i] ?? '')) i++;
		if (text[i] !== '(') return i;
		let depth = 0;
		for (; i < text.length; i++) {
			const char = text[i];
			if (char === '\\') i++;
			else if (char === '(') depth++;
			else if (char === ')' && --depth === 0) {
				i++;
				break;
			}
		}
		if (depth > 0) return text.length;
	}
}

/**
 * The authserv-id an `Authentication-Results` field claims (RFC 8601
 * §2.2), lower case, a quoted-string unquoted; `''` when it has none.
 */
export function authservId(field: Uint8Array): string {
	const text = decoder.decode(field);
	const colon = text.indexOf(':');
	if (colon === -1) return '';
	let i = skipCfws(text, colon + 1);
	if (text[i] === '"') {
		let id = '';
		for (i++; i < text.length && text[i] !== '"'; i++) {
			if (text[i] === '\\') i++;
			id += text[i] ?? '';
		}
		return id.toLowerCase();
	}
	const match = /^[^\s;()"]+/.exec(text.slice(i));
	return (match?.[0] ?? '').toLowerCase();
}

/** Whether `id` names `hostname`, a trailing dot aside. */
function sameHost(id: string, hostname: string): boolean {
	return id.replace(/\.$/, '') === hostname.toLowerCase().replace(/\.$/, '');
}

/**
 * The header's fields less those a sender could forge to fool a reader
 * here: every `Authentication-Results` claiming `hostname` as its
 * authserv-id (RFC 8601 §5), and every `Return-Path`, which only the
 * delivering server writes (RFC 5321 §4.4). Answers what is kept, in
 * order, and how many fields were taken out.
 */
export function stripForged(
	header: Uint8Array,
	hostname: string,
): { kept: Uint8Array[]; removed: number } {
	const kept: Uint8Array[] = [];
	let removed = 0;
	for (const field of splitFields(header)) {
		const name = fieldName(field);
		const forged =
			name === 'return-path' ||
			(name === 'authentication-results' &&
				sameHost(authservId(field), hostname));
		if (forged) removed++;
		else kept.push(field);
	}
	return { kept, removed };
}

/**
 * The `Return-Path` field for the envelope sender (RFC 5321 §4.4), `<>`
 * for a bounce; an address that would break the line is left out of it.
 */
export function returnPath(from: string): string {
	const safe = /^[\x21-\x7e\u0080-\u{10ffff}]*$/u.test(from) ? from : '';
	return `Return-Path: <${safe}>\r\n`;
}

const encoder = new TextEncoder();

/** `lines` (each ending in CRLF), then `fields`, as one array of bytes. */
export function joinHeader(
	lines: readonly string[],
	fields: readonly Uint8Array[],
): Uint8Array {
	const head = lines.map((line) => encoder.encode(line));
	const parts = [...head, ...fields];
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
