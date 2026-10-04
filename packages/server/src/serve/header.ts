import { domainToASCII } from 'node:url';

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
	if (from === 0 && bytes[0] === CR && bytes[1] === LF) return 0;
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

/**
 * Finds where a header ends as it arrives in chunks, each byte looked at
 * once: the index `headerEnd` would give for the whole message.
 */
export class HeaderEndScanner {
	/** How much of CRLF CRLF was just seen; a message starts after a line end. */
	#matched = 2;
	#position = 0;
	/** The blank line's index, or `-1` while not found. */
	end = -1;

	add(chunk: Uint8Array): void {
		if (this.end !== -1) {
			this.#position += chunk.length;
			return;
		}
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i];
			const expected = this.#matched % 2 === 0 ? CR : LF;
			if (byte === expected) this.#matched++;
			else this.#matched = byte === CR ? 1 : 0;
			if (this.#matched === 4) {
				this.end = this.#position + i - 1;
				break;
			}
		}
		this.#position += chunk.length;
	}

	/** Bytes seen so far. */
	get length(): number {
		return this.#position;
	}
}

const decoder = new TextDecoder('utf-8', { fatal: false });

/** The field's name, lower case; `''` when it has no colon. */
export function fieldName(field: Uint8Array): string {
	const colon = field.indexOf(0x3a);
	if (colon <= 0) return '';
	return decoder.decode(field.subarray(0, colon)).trim().toLowerCase();
}

/**
 * Skips CFWS (RFC 5322 §3.2.2) from `at` in a field read byte for byte:
 * spaces, tabs, a CRLF that folds (a space or a tab after it), and
 * comments, nested and with quoted pairs. `-1` for a comment never
 * closed.
 */
function skipCfws(text: string, at: number): number {
	let i = at;
	for (;;) {
		const char = text[i];
		if (char === ' ' || char === '\t') {
			i++;
		} else if (
			text.startsWith('\r\n', i) &&
			(text[i + 2] === ' ' || text[i + 2] === '\t')
		) {
			i += 3;
		} else if (char === '(') {
			let depth = 0;
			for (; i < text.length; i++) {
				const c = text[i];
				if (c === '\\') i++;
				else if (c === '(') depth++;
				else if (c === ')' && --depth === 0) break;
			}
			if (depth > 0) return -1;
			i++;
		} else {
			return i;
		}
	}
}

/** A host name in ASCII letters, digits and hyphens, a trailing dot allowed. */
const HOST =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\.?$/;

/**
 * The authserv-id of an `Authentication-Results` field (RFC 8601 §2.2),
 * lower case without a trailing dot, when it is a plain ASCII host name
 * followed only by CFWS, an `authres-version`, and `;`; `undefined` for
 * anything else — an empty id, a byte outside ASCII, a control
 * character, any other character, a field that does not parse. Read
 * byte for byte, so no decoding turns a stray byte into anything.
 */
export function foreignAuthservId(field: Uint8Array): string | undefined {
	const text = Buffer.from(field).toString('latin1');
	const colon = text.indexOf(':');
	if (colon === -1) return undefined;
	let i = skipCfws(text, colon + 1);
	if (i === -1) return undefined;
	let id = '';
	if (text[i] === '"') {
		for (i++; i < text.length && text[i] !== '"'; i++) {
			if (text[i] === '\\') i++;
			id += text[i] ?? '';
		}
		if (text[i] !== '"') return undefined;
		i++;
	} else {
		const match = /^[^ \t\r\n;(]+/.exec(text.slice(i));
		id = match?.[0] ?? '';
		i += id.length;
	}
	if (!HOST.test(id)) return undefined;
	const end = i;
	i = skipCfws(text, i);
	if (i === -1) return undefined;
	// [CFWS authres-version]: digits, after CFWS only.
	const version = /^[0-9]+/.exec(text.slice(i));
	if (version !== null && i > end) {
		i = skipCfws(text, i + version[0].length);
		if (i === -1) return undefined;
	}
	if (text[i] !== ';') return undefined;
	return id.toLowerCase().replace(/\.$/, '');
}

/** The server's name as an `Authentication-Results` names it: its A-label, lower case, no trailing dot. */
export function authservIdOf(hostname: string): string {
	return (domainToASCII(hostname) || hostname).toLowerCase().replace(/\.$/, '');
}

/**
 * The header's fields less those a sender could forge to fool a reader
 * here, by an allow-list: an `Authentication-Results` is kept only when
 * its authserv-id is a plain ASCII host name (`foreignAuthservId`) that
 * is neither the server's own name nor a domain it hosts — the ADMD
 * often signs its results with its domain (RFC 8601 §5); one with no
 * authserv-id at all goes too. `ARC-Authentication-Results` is another
 * field, sealed by ARC, and is kept as is. Every `Return-Path` goes, as
 * only the delivering server writes one (RFC 5321 §4.4). Answers what
 * is kept, in order, and how many fields were taken out.
 *
 * `isLocalDomain` is asked about an id already lower case, ASCII, and
 * without a trailing dot.
 */
export function stripForged(
	header: Uint8Array,
	hostname: string,
	isLocalDomain: (id: string) => boolean = () => false,
): { kept: Uint8Array[]; removed: number } {
	const own = authservIdOf(hostname);
	const kept: Uint8Array[] = [];
	let removed = 0;
	for (const field of splitFields(header)) {
		const name = fieldName(field);
		let forged = name === 'return-path';
		if (name === 'authentication-results') {
			const id = foreignAuthservId(field);
			forged = id === undefined || id === own || isLocalDomain(id);
		}
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
