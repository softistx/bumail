/** The part of a DSN that returns the original message (RFC 3464 §2, RFC 6522 §3). */

const CR = 13;
const LF = 10;

/** Every bare CR or LF as CRLF: a DSN is sent as lines, whatever the original held. */
function crlf(bytes: Uint8Array): Uint8Array {
	const out: number[] = [];
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i] as number;
		if (byte === CR) {
			out.push(CR, LF);
			if (bytes[i + 1] === LF) i++;
		} else if (byte === LF) {
			out.push(CR, LF);
		} else {
			out.push(byte);
		}
	}
	return Uint8Array.from(out);
}

/** Where the header block ends: past the blank line, or the whole message when it has none. */
function headerEnd(bytes: Uint8Array): number {
	for (let i = 0; i + 3 < bytes.length; i++) {
		if (
			bytes[i] === CR &&
			bytes[i + 1] === LF &&
			bytes[i + 2] === CR &&
			bytes[i + 3] === LF
		) {
			return i + 2;
		}
	}
	return bytes.length;
}

/** The first `max` bytes at most, cut after the last whole line. */
function wholeLines(bytes: Uint8Array, max: number): Uint8Array {
	if (bytes.length <= max) return bytes;
	const cut = bytes.subarray(0, max).lastIndexOf(LF);
	return bytes.subarray(0, cut + 1);
}

export interface Returned {
	/** `text/rfc822-headers` or `message/rfc822`. */
	readonly type: string;
	/** Lines ending in CRLF, the last one included. */
	readonly body: Uint8Array;
	/** It holds a byte past ASCII: the part says `8bit`. */
	readonly eightBit: boolean;
}

/**
 * The original as a DSN returns it: the whole message when asked and it
 * fits `max` bytes, else its header fields, cut after the last whole line
 * that fits. Never more than `max` bytes.
 */
export function returned(
	original: Uint8Array,
	mode: 'headers' | 'full',
	max: number,
): Returned {
	const message = crlf(original.subarray(0, max * 2 + 2));
	const whole = original.length <= max && message.length <= max;
	const body =
		whole && mode === 'full'
			? message
			: wholeLines(message.subarray(0, headerEnd(message)), max);
	return {
		type: whole && mode === 'full' ? 'message/rfc822' : 'text/rfc822-headers',
		body,
		eightBit: body.some((byte) => byte > 0x7f),
	};
}
