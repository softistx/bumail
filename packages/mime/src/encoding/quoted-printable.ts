import { concat } from './bytes';

const EQUALS = 0x3d;
const CR = 0x0d;
const LF = 0x0a;
const SPACE = 0x20;
const TAB = 0x09;
const HEX = '0123456789ABCDEF';

function hexValue(byte: number): number {
	if (byte >= 0x30 && byte <= 0x39) return byte - 0x30;
	if (byte >= 0x41 && byte <= 0x46) return byte - 0x37;
	if (byte >= 0x61 && byte <= 0x66) return byte - 0x57;
	return -1;
}

function isWhite(byte: number | undefined): boolean {
	return byte === SPACE || byte === TAB;
}

/**
 * Decodes one line, without its line break. Trailing white space is dropped
 * (rule 3 of RFC 2045 §6.7), a final `=` is a soft line break, and an `=`
 * not followed by two hex digits is kept as it is, as §6.7 recommends.
 */
function decodeLine(line: Uint8Array, out: number[]): boolean {
	let end = line.length;
	while (end > 0 && isWhite(line[end - 1])) end--;
	let soft = false;
	if (end > 0 && line[end - 1] === EQUALS) {
		soft = true;
		end--;
	}
	for (let i = 0; i < end; i++) {
		const byte = line[i] as number;
		if (byte === EQUALS && i + 2 < end) {
			const high = hexValue(line[i + 1] as number);
			const low = hexValue(line[i + 2] as number);
			if (high >= 0 && low >= 0) {
				out.push(high * 16 + low);
				i += 2;
				continue;
			}
		}
		out.push(byte);
	}
	return soft;
}

/**
 * Decodes the start of a line whose end has not come: every byte but an
 * `=` in the last two, which may open an escape the next chunk completes.
 * White space is kept, since it is only trailing once the line ends. A
 * final CR is held too: the next chunk's LF may make it a line break.
 * Returns how many bytes it consumed.
 */
function decodePartial(line: Uint8Array, out: number[]): number {
	const end = line[line.length - 1] === CR ? line.length - 1 : line.length;
	let i = 0;
	for (; i < end; i++) {
		const byte = line[i] as number;
		if (byte !== EQUALS) {
			out.push(byte);
			continue;
		}
		if (i + 2 >= end) break;
		const high = hexValue(line[i + 1] as number);
		const low = hexValue(line[i + 2] as number);
		if (high >= 0 && low >= 0) {
			out.push(high * 16 + low);
			i += 2;
		} else {
			out.push(byte);
		}
	}
	return i;
}

/** Decodes quoted-printable lines; ends the input as if it were complete. */
function decodeLines(data: Uint8Array, final: boolean, out: number[]): number {
	let start = 0;
	for (;;) {
		const lf = data.indexOf(LF, start);
		if (lf < 0) break;
		const lineEnd = lf > start && data[lf - 1] === CR ? lf - 1 : lf;
		const soft = decodeLine(data.subarray(start, lineEnd), out);
		if (!soft) out.push(CR, LF);
		start = lf + 1;
	}
	if (final && start < data.length) {
		decodeLine(data.subarray(start), out);
		return data.length;
	}
	return start;
}

/** Quoted-printable (RFC 2045 §6.7) to bytes. Line breaks come out as CRLF. */
export function decodeQuotedPrintable(input: Uint8Array | string): Uint8Array {
	const data =
		typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const out: number[] = [];
	decodeLines(data, true, out);
	return Uint8Array.from(out);
}

/**
 * Decodes quoted-printable arriving in chunks of any size. It holds back the
 * line in progress, since its trailing spaces and final `=` only mean
 * something once its end is known; a line longer than `maxLine` bytes —
 * which RFC 2045 forbids past 76 — is decoded without waiting for its end,
 * so the decoder never holds more than `maxLine` bytes plus a chunk.
 */
export class QuotedPrintableDecoder {
	#rest: Uint8Array = new Uint8Array(0);
	readonly #maxLine: number;

	constructor(maxLine = 8192) {
		this.#maxLine = maxLine;
	}

	write(chunk: Uint8Array): Uint8Array {
		const data = concat(this.#rest, chunk);
		const out: number[] = [];
		let used = decodeLines(data, false, out);
		if (data.length - used > this.#maxLine) {
			used += decodePartial(data.subarray(used), out);
		}
		this.#rest = data.slice(used);
		return Uint8Array.from(out);
	}

	end(): Uint8Array {
		const out: number[] = [];
		decodeLines(this.#rest, true, out);
		this.#rest = new Uint8Array(0);
		return Uint8Array.from(out);
	}
}

/**
 * Encodes text as quoted-printable (RFC 2045 §6.7): its line breaks, CRLF or
 * LF, stay hard line breaks written as CRLF, and lines longer than 76
 * characters get soft breaks. A string is encoded as UTF-8 first.
 */
export function encodeQuotedPrintable(input: Uint8Array | string): string {
	const data =
		typeof input === 'string' ? new TextEncoder().encode(input) : input;
	const lines: string[] = [];
	let start = 0;
	while (start <= data.length) {
		let lf = data.indexOf(LF, start);
		const last = lf < 0;
		if (last) lf = data.length;
		const end = lf > start && data[lf - 1] === CR ? lf - 1 : lf;
		lines.push(encodeLine(data.subarray(start, end)));
		start = lf + 1;
		if (last) break;
	}
	return lines.join('\r\n');
}

function encodeLine(line: Uint8Array): string {
	let out = '';
	let width = 0;
	for (let i = 0; i < line.length; i++) {
		const byte = line[i] as number;
		const atEnd = i === line.length - 1;
		const literal =
			(byte >= 33 && byte <= 126 && byte !== EQUALS) ||
			(isWhite(byte) && !atEnd);
		const piece = literal
			? String.fromCharCode(byte)
			: `=${HEX[byte >> 4]}${HEX[byte & 15]}`;
		// A soft break leaves room for its own `=` within the 76 characters,
		// and is not needed when the piece ends the line exactly at 76.
		const limit = atEnd ? 76 : 75;
		if (width + piece.length > limit) {
			out += '=\r\n';
			width = 0;
		}
		out += piece;
		width += piece.length;
	}
	return out;
}
