/** What a response is written as: text, or the bytes of a literal. */
export type Piece = string | Uint8Array | Blob;

/** The longest string sent quoted; a longer one goes as a literal. */
const MAX_QUOTED = 1024;

const encoder = new TextEncoder();

/** Whether a string can go quoted: printable ASCII, not too long. */
export function canQuote(value: string): boolean {
	if (value.length > MAX_QUOTED) return false;
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) return false;
	}
	return true;
}

/** `"value"`, escaping `"` and `\`; the caller checked `canQuote`. */
export function quoted(value: string): string {
	let out = '"';
	for (const char of value)
		out += char === '"' || char === '\\' ? `\\${char}` : char;
	return `${out}"`;
}

/** ASTRING-CHAR (RFC 9051 §9), for a string sent as an atom. */
const ATOM = /^[!#$&'+-[\]-z|}~]+$/;

/**
 * One response line, built in order: text, strings quoted or sent as a
 * literal when they cannot be quoted, and literal bytes. `pieces` is what
 * goes on the wire, the final CRLF included once `done` is called.
 */
export class Response {
	readonly pieces: Piece[] = [];
	#text = '';

	text(text: string): this {
		this.#text += text;
		return this;
	}

	#flush(): void {
		if (this.#text !== '') this.pieces.push(this.#text);
		this.#text = '';
	}

	/** Bytes as a literal: `{size}` CRLF, then the bytes. */
	literal(data: Uint8Array | Blob): this {
		const size = data instanceof Blob ? data.size : data.length;
		this.#text += `{${size}}\r\n`;
		this.#flush();
		if (size > 0) this.pieces.push(data);
		return this;
	}

	/** A string: quoted when it can be, a literal of its UTF-8 otherwise. */
	string(value: string): this {
		return canQuote(value)
			? this.text(quoted(value))
			: this.literal(encoder.encode(value));
	}

	/** `NIL` for `undefined`, a string otherwise. */
	nstring(value: string | undefined): this {
		return value === undefined ? this.text('NIL') : this.string(value);
	}

	/** An atom when it can be one (and is not `NIL`), a string otherwise. */
	astring(value: string): this {
		return ATOM.test(value) && value.toUpperCase() !== 'NIL'
			? this.text(value)
			: this.string(value);
	}

	/** Ends the line. */
	done(): Piece[] {
		this.#text += '\r\n';
		this.#flush();
		return this.pieces;
	}
}

/** `* text` CRLF, as pieces. */
export function untagged(text: string): Piece[] {
	return [`* ${text}\r\n`];
}

/** `tag OK|NO|BAD text` CRLF. */
export function tagged(
	tag: string,
	status: 'OK' | 'NO' | 'BAD',
	text: string,
): Piece[] {
	return [`${tag} ${status} ${text}\r\n`];
}
