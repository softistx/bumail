import { Base64Decoder } from './base64';
import { QuotedPrintableDecoder } from './quoted-printable';

/** Decodes a body arriving in chunks. */
export interface TransferDecoder {
	write(chunk: Uint8Array): Uint8Array;
	end(): Uint8Array;
}

const IDENTITY: TransferDecoder = {
	write: (chunk) => chunk,
	end: () => new Uint8Array(0),
};

/**
 * The decoder for a `Content-Transfer-Encoding`: base64, quoted-printable,
 * or none for 7bit, 8bit, binary and anything unknown — RFC 2045 §6.4 asks
 * a reader to treat an unknown encoding's body as opaque data.
 */
export function createTransferDecoder(
	encoding: string | undefined,
): TransferDecoder {
	switch (encoding?.trim().toLowerCase()) {
		case 'base64':
			return new Base64Decoder();
		case 'quoted-printable':
			return new QuotedPrintableDecoder();
		default:
			return IDENTITY;
	}
}

/** Decodes a whole body at once. */
export function decodeTransfer(
	body: Uint8Array,
	encoding: string | undefined,
): Uint8Array {
	const decoder = createTransferDecoder(encoding);
	const head = decoder.write(body);
	const tail = decoder.end();
	if (tail.length === 0) return head;
	const out = new Uint8Array(head.length + tail.length);
	out.set(head, 0);
	out.set(tail, head.length);
	return out;
}
