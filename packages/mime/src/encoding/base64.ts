const NOT_ALPHABET = /[^A-Za-z0-9+/]/g;

/**
 * Base64 (RFC 2045 §6.8), in lines of `lineLength` characters joined by
 * CRLF; `0` writes one line.
 */
export function encodeBase64(data: Uint8Array, lineLength = 76): string {
	const text = data.toBase64();
	if (lineLength <= 0 || text.length <= lineLength) return text;
	const lines: string[] = [];
	for (let i = 0; i < text.length; i += lineLength) {
		lines.push(text.slice(i, i + lineLength));
	}
	return lines.join('\r\n');
}

/**
 * Decodes base64 the way RFC 2045 §6.8 asks a reader to: characters outside
 * the alphabet — line breaks, spaces, stray punctuation — are ignored, and
 * so is a final group too short to hold a byte.
 */
export function decodeBase64(text: string): Uint8Array {
	const clean = text.replace(NOT_ALPHABET, '');
	const usable = clean.length - (clean.length % 4 === 1 ? 1 : 0);
	return Uint8Array.fromBase64(clean.slice(0, usable), {
		lastChunkHandling: 'loose',
	});
}

/** Decodes base64 arriving in chunks of any size, keeping at most 3 characters between them. */
export class Base64Decoder {
	#rest = '';

	write(chunk: Uint8Array): Uint8Array {
		const text =
			this.#rest +
			new TextDecoder('latin1').decode(chunk).replace(NOT_ALPHABET, '');
		const whole = text.length - (text.length % 4);
		this.#rest = text.slice(whole);
		return whole === 0
			? new Uint8Array(0)
			: Uint8Array.fromBase64(text.slice(0, whole), {
					lastChunkHandling: 'loose',
				});
	}

	end(): Uint8Array {
		const rest = this.#rest;
		this.#rest = '';
		return decodeBase64(rest);
	}
}
