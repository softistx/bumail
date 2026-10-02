import { concat, join } from './bytes';

const NOT_ALPHABET = /[^A-Za-z0-9+/=]/g;

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

/** One run of base64 characters, its padding gone: a final group too short to hold a byte is dropped. */
function decodeRun(run: string): Uint8Array {
	const usable = run.length - (run.length % 4 === 1 ? 1 : 0);
	return Uint8Array.fromBase64(run.slice(0, usable), {
		lastChunkHandling: 'loose',
	});
}

/**
 * Decodes base64 the way RFC 2045 §6.8 asks a reader to: characters outside
 * the alphabet — line breaks, spaces, stray punctuation — are ignored, and
 * so is a final group too short to hold a byte. Padding ends a run: base64
 * written in pieces, `Zm8=YmFy`, decodes piece by piece.
 */
export function decodeBase64(text: string): Uint8Array {
	const runs = text
		.replace(NOT_ALPHABET, '')
		.split(/=+/)
		.filter((run) => run !== '');
	return runs.length === 1
		? decodeRun(runs[0] as string)
		: join(runs.map(decodeRun));
}

/** Decodes base64 arriving in chunks of any size, keeping at most 3 characters between them. */
export class Base64Decoder {
	#rest = '';

	write(chunk: Uint8Array): Uint8Array {
		let text =
			this.#rest +
			new TextDecoder('latin1').decode(chunk).replace(NOT_ALPHABET, '');
		// Everything up to the last padding is complete runs.
		const pad = text.lastIndexOf('=');
		const head = pad < 0 ? '' : text.slice(0, pad + 1);
		if (pad >= 0) text = text.slice(pad + 1);
		const whole = text.length - (text.length % 4);
		this.#rest = text.slice(whole);
		return concat(decodeBase64(head), decodeRun(text.slice(0, whole)));
	}

	end(): Uint8Array {
		const rest = this.#rest;
		this.#rest = '';
		return decodeBase64(rest);
	}
}
