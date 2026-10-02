import { join } from '../encoding/bytes';
import { MimeError } from '../errors';
import type { MimeParserOptions } from './types';

export const LF = 0x0a;
const CR = 0x0d;
export const DASH = 0x2d;
/** RFC 2046 §5.1.1 caps a boundary at 70 characters; padding may follow a delimiter. */
export const DELIMITER_MAX = 1000;

export function lineBreakLength(line: Uint8Array): number {
	if (line[line.length - 1] !== LF) return 0;
	return line[line.length - 2] === CR ? 2 : 1;
}

function startsWith(line: Uint8Array, prefix: Uint8Array): boolean {
	if (line.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (line[i] !== prefix[i]) return false;
	}
	return true;
}

/** `'close'` for `--boundary--`, `'next'` for `--boundary`, `undefined` otherwise. */
export function delimiter(
	content: Uint8Array,
	boundary: Uint8Array,
): 'next' | 'close' | undefined {
	if (!startsWith(content, boundary)) return undefined;
	let i = boundary.length;
	let close = false;
	if (content[i] === DASH && content[i + 1] === DASH) {
		close = true;
		i += 2;
	}
	for (; i < content.length; i++) {
		if (content[i] !== 0x20 && content[i] !== 0x09) return undefined;
	}
	return close ? 'close' : 'next';
}

/** A limit from the options: an integer no smaller than `min`, or the default. */
export function limit(
	options: MimeParserOptions,
	name: keyof MimeParserOptions,
	fallback: number,
	min: number,
): number {
	const value = options[name];
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < min) {
		throw new MimeError(
			'INVALID_OPTION',
			`MimeParser: ${name} must be an integer of at least ${min}, not ${value}`,
		);
	}
	return value;
}

/** The line breaks a part can hold between writes, so it keeps no caller's buffer. */
const CRLF_BYTES = new Uint8Array([CR, LF]);
const LF_BYTES = new Uint8Array([LF]);

/** A line break as one of two shared constants: `held` must not keep a caller's chunk. */
export function lineBreakOf(held: Uint8Array): Uint8Array {
	return held.length === 2 ? CRLF_BYTES : LF_BYTES;
}

/**
 * Cuts chunks into lines, each ending with its LF. A line within one chunk
 * is a view of it; one that spans chunks is joined once it ends. What is
 * left after the last LF is copied, as the caller may reuse its buffer.
 */
export class LineAssembler {
	#pending: Uint8Array[] = [];
	#size = 0;

	/** Bytes held of the line in progress. */
	get size(): number {
		return this.#size;
	}

	/** Passes every line `chunk` completes to `onLine`, and keeps the rest. */
	push(chunk: Uint8Array, onLine: (line: Uint8Array) => void): void {
		let start = 0;
		for (;;) {
			const lf = chunk.indexOf(LF, start);
			if (lf < 0) break;
			let line = chunk.subarray(start, lf + 1);
			if (this.#size > 0) {
				line = join([...this.#pending, line]);
				this.#pending = [];
				this.#size = 0;
			}
			onLine(line);
			start = lf + 1;
		}
		if (start < chunk.length) {
			this.#pending.push(chunk.slice(start));
			this.#size += chunk.length - start;
		}
	}

	/**
	 * The line in progress but its last byte, which may be the CR of a CRLF
	 * split across chunks: for a line too long to hold.
	 */
	takeAllButLast(): Uint8Array {
		const line = join(this.#pending);
		this.#pending = [line.subarray(line.length - 1)];
		this.#size = 1;
		return line.subarray(0, line.length - 1);
	}

	/** The line in progress, at the end of input. */
	takeAll(): Uint8Array | undefined {
		if (this.#size === 0) return undefined;
		const line = join(this.#pending);
		this.#pending = [];
		this.#size = 0;
		return line;
	}
}
