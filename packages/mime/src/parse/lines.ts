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
