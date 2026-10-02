import { decodeUnlabelled } from '../encoding/charset';
import { decodeEncodedWords } from './encoded-words';

/** One header field as it was written, unfolded. */
export interface HeaderField {
	/** The name as written; compare it case-insensitively. */
	readonly name: string;
	/** The raw value: unfolded (RFC 5322 §2.2.3), not decoded, without the leading white space. */
	readonly value: string;
}

/**
 * The header fields of a message or a part, in order. Names are matched
 * case-insensitively; a field that appears more than once keeps every
 * occurrence.
 */
export class MessageHeaders implements Iterable<HeaderField> {
	readonly #fields: readonly HeaderField[];

	constructor(fields: readonly HeaderField[] = []) {
		this.#fields = fields;
	}

	/** The raw value of the first field with this name. */
	get(name: string): string | undefined {
		const key = name.toLowerCase();
		return this.#fields.find((field) => field.name.toLowerCase() === key)
			?.value;
	}

	/** The raw values of every field with this name, in order. */
	getAll(name: string): string[] {
		const key = name.toLowerCase();
		return this.#fields
			.filter((field) => field.name.toLowerCase() === key)
			.map((field) => field.value);
	}

	/** The first field's value with its encoded-words decoded (RFC 2047). */
	text(name: string): string | undefined {
		const value = this.get(name);
		return value === undefined ? undefined : decodeEncodedWords(value).trim();
	}

	has(name: string): boolean {
		return this.get(name) !== undefined;
	}

	get size(): number {
		return this.#fields.length;
	}

	[Symbol.iterator](): Iterator<HeaderField> {
		return this.#fields[Symbol.iterator]();
	}
}

/**
 * Parses a header block — the lines before the blank line — into its
 * fields. Lines end in CRLF or a bare LF; a line that starts with white
 * space continues the field before it. A line with no colon is not a field
 * and is skipped. Bytes are read as UTF-8 (RFC 6532), or as windows-1252
 * when they are not valid UTF-8.
 */
export function parseHeaderBlock(block: Uint8Array | string): MessageHeaders {
	const text = typeof block === 'string' ? block : decodeUnlabelled(block);
	const fields: HeaderField[] = [];
	let name: string | undefined;
	let value = '';
	const flush = () => {
		if (name !== undefined)
			fields.push({ name, value: value.replace(/^[ \t]+/, '').trimEnd() });
		name = undefined;
	};
	for (const line of text.split(/\r?\n/)) {
		if (line === '') continue;
		if (line[0] === ' ' || line[0] === '\t') {
			if (name !== undefined) value += line;
			continue;
		}
		flush();
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		name = line.slice(0, colon).trimEnd();
		value = line.slice(colon + 1);
	}
	flush();
	return new MessageHeaders(fields);
}
