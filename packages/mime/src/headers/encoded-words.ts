import { decodeBase64 } from '../encoding/base64';
import { concat } from '../encoding/bytes';
import { charsetLabel, decodeCharset } from '../encoding/charset';

/** An encoded-word (RFC 2047 §2), with RFC 2231 §5's optional `*language`. */
const ENCODED_WORD = /=\?([^?\s*]+)(?:\*[^?\s]*)?\?([BbQq])\?([^?\s]*)\?=/g;

function decodeQ(text: string): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < text.length; i++) {
		const char = text[i] as string;
		if (char === '_') {
			out.push(0x20);
		} else if (
			char === '=' &&
			/^[0-9A-Fa-f]{2}$/.test(text.slice(i + 1, i + 3))
		) {
			out.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			out.push(char.charCodeAt(0) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

/**
 * Decodes the encoded-words in a header value (RFC 2047 §6). White space
 * between two adjacent encoded-words is dropped (§6.2); adjacent words in
 * one charset are decoded together, so a character whose bytes a sender
 * split across two words still reads. A word in a charset the platform does
 * not know is left as it is.
 */
export function decodeEncodedWords(value: string): string {
	if (!value.includes('=?')) return value;
	let out = '';
	let last = 0;
	let pending: { charset: string; bytes: Uint8Array } | undefined;
	const flush = () => {
		if (pending) out += decodeCharset(pending.bytes, pending.charset);
		pending = undefined;
	};
	for (const match of value.matchAll(ENCODED_WORD)) {
		const [word, charset = '', encoding = '', text = ''] = match;
		const between = value.slice(last, match.index);
		if (charsetLabel(charset) === undefined) continue;
		const bytes =
			encoding.toUpperCase() === 'B' ? decodeBase64(text) : decodeQ(text);
		const adjacent = pending !== undefined && /^[ \t\r\n]*$/.test(between);
		if (!adjacent) {
			flush();
			out += between;
		}
		if (pending && pending.charset.toLowerCase() === charset.toLowerCase()) {
			pending.bytes = concat(pending.bytes, bytes);
		} else {
			flush();
			pending = { charset, bytes };
		}
		last = match.index + word.length;
	}
	flush();
	return out + value.slice(last);
}

const B_PREFIX = '=?UTF-8?B?';
/** 45 bytes are 60 base64 characters: with `=?UTF-8?B?` and `?=`, 72 of the 75 allowed. */
const B_BYTES = 45;

/** UTF-8 bytes of `text`, in pieces of at most `max` bytes that never split a character. */
function utf8Pieces(text: string, max: number): Uint8Array[] {
	const pieces: Uint8Array[] = [];
	let piece = '';
	let size = 0;
	const encoder = new TextEncoder();
	for (const char of text) {
		const length = encoder.encode(char).length;
		if (size + length > max && piece !== '') {
			pieces.push(encoder.encode(piece));
			piece = '';
			size = 0;
		}
		piece += char;
		size += length;
	}
	if (piece !== '') pieces.push(encoder.encode(piece));
	return pieces;
}

/** `text` as one or more `B` encoded-words in UTF-8, joined by a space. */
export function encodeWord(text: string): string {
	return utf8Pieces(text, B_BYTES)
		.map((bytes) => `${B_PREFIX}${bytes.toBase64()}?=`)
		.join(' ');
}

const NEEDS_ENCODING = /[^\x20-\x7e\t]|=\?/;

/**
 * An unstructured header value (RFC 2047 §5(1)) safe to write in 7-bit: a
 * run of words that holds a character outside printable ASCII — or that
 * looks like an encoded-word already — is written as encoded-words, the
 * rest is left readable.
 */
export function encodeHeaderValue(value: string): string {
	if (!NEEDS_ENCODING.test(value)) return value;
	const words = value.split(/([ \t]+)/);
	const out: string[] = [];
	let run: string[] = [];
	const flush = () => {
		if (run.length === 0) return;
		// White space between two encoded-words is dropped by a reader, so
		// what separates the words of a run is encoded with them.
		const last = run[run.length - 1] as string;
		const trailing = /^[ \t]+$/.test(last) ? (run.pop() as string) : '';
		out.push(encodeWord(run.join('')), trailing);
		run = [];
	};
	for (const word of words) {
		if (word === '') continue;
		const space = /^[ \t]+$/.test(word);
		if (!space && NEEDS_ENCODING.test(word)) {
			run.push(word);
		} else if (space && run.length > 0) {
			run.push(word);
		} else {
			flush();
			out.push(word);
		}
	}
	flush();
	return out.join('');
}
