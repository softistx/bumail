const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

/**
 * Writes the content of `DATA` (RFC 5321 §4.1.1.4), the other half of
 * `DataReader`: a dot is added before every line that starts with one
 * (§4.5.2), and `end` closes the message with `<CRLF>.<CRLF>`. One pass,
 * one byte at a time, whatever the chunks.
 *
 * A bare CR or LF is counted in `bareLineBreaks`, as `DataReader` counts
 * it, for the caller to refuse the message: a server that reads one as a
 * line end is the SMTP smuggling a server refuses. With `normalize`, each
 * becomes CRLF instead. `eightBit` says whether a byte above 127 was seen.
 */
export class DataWriter {
	readonly #normalize: boolean;
	#lineStart = true;
	#heldCr = false;
	bareLineBreaks = 0;
	eightBit = false;

	constructor(normalize = false) {
		this.#normalize = normalize;
	}

	/** A bare CR or LF: CRLF when normalising, else counted and kept as it is. */
	#bare(out: Uint8Array, n: number, byte: number): number {
		if (this.#normalize) {
			out[n++] = CR;
			out[n++] = LF;
			this.#lineStart = true;
			return n;
		}
		this.bareLineBreaks++;
		out[n++] = byte;
		this.#lineStart = false;
		return n;
	}

	/** The next bytes of the message, stuffed. */
	write(chunk: Uint8Array): Uint8Array {
		// At worst every byte doubles: a dot or a bare line break each.
		const out = new Uint8Array(chunk.length * 2 + 2);
		let n = 0;
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i] as number;
			if (this.#heldCr) {
				this.#heldCr = false;
				if (byte === LF) {
					out[n++] = CR;
					out[n++] = LF;
					this.#lineStart = true;
					continue;
				}
				n = this.#bare(out, n, CR);
			}
			if (byte === CR) {
				this.#heldCr = true;
				continue;
			}
			if (byte === LF) {
				n = this.#bare(out, n, LF);
				continue;
			}
			if (byte === DOT && this.#lineStart) out[n++] = DOT;
			if (byte > 0x7f) this.eightBit = true;
			out[n++] = byte;
			this.#lineStart = false;
		}
		return out.subarray(0, n);
	}

	/** The end of the message: a CRLF if its last line has none, then `.` CRLF. */
	end(): Uint8Array {
		const out = new Uint8Array(7);
		let n = 0;
		if (this.#heldCr) {
			this.#heldCr = false;
			n = this.#bare(out, n, CR);
		}
		if (!this.#lineStart) {
			out[n++] = CR;
			out[n++] = LF;
		}
		out[n++] = DOT;
		out[n++] = CR;
		out[n++] = LF;
		return out.subarray(0, n);
	}
}
