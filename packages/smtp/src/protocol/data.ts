const CR = 0x0d;
const LF = 0x0a;
const DOT = 0x2e;

/** The result of one chunk of DATA. */
export interface DataChunk {
	/** The message bytes in this chunk, dot-unstuffed. */
	readonly data: Uint8Array;
	/** The terminating `<CRLF>.<CRLF>` was read. */
	readonly done: boolean;
	/** What followed the terminator: the next pipelined commands. */
	readonly rest: Uint8Array;
}

/**
 * Reads the content of `DATA` (RFC 5321 §4.1.1.4): removes the leading dot
 * that §4.5.2 adds to lines starting with one, and stops at `<CRLF>.<CRLF>`
 * — that exact sequence and no other, so a bare LF before a dot cannot end
 * the message (SMTP smuggling). It counts the bare CRs and LFs it meets,
 * for the server to refuse the message.
 */
export class DataReader {
	/** The next byte starts a line: it follows CRLF, or opens the message. */
	#lineStart = true;
	/** Bytes held back: a CR, or a dot at a line start, whose meaning depends on what follows. */
	#held: number[] = [];
	#size = 0;
	bareLineBreaks = 0;

	/** The bytes of message read so far, after unstuffing. */
	get size(): number {
		return this.#size;
	}

	write(chunk: Uint8Array): DataChunk {
		// The output never outgrows the chunk and the two bytes held before it.
		const out = new Uint8Array(chunk.length + 2);
		let n = 0;
		for (let i = 0; i < chunk.length; i++) {
			const byte = chunk[i] as number;
			const held = this.#held;
			if (held.length > 0) {
				// Held: [CR], [DOT], [DOT, CR].
				if (held[0] === DOT && held.length === 1) {
					if (byte === CR) {
						held.push(CR);
						continue;
					}
					// A stuffed dot: drop it, and read this byte as the line's first.
					this.#held = [];
					this.#lineStart = false;
					i--;
					continue;
				}
				if (held[0] === DOT && held.length === 2) {
					this.#held = [];
					if (byte === LF) {
						this.#size += n;
						return {
							data: out.subarray(0, n),
							done: true,
							rest: chunk.slice(i + 1),
						};
					}
					// `.` CR x: the dot was stuffing; the CR is bare.
					this.bareLineBreaks++;
					out[n++] = CR;
					this.#lineStart = false;
					i--;
					continue;
				}
				// Held a CR.
				this.#held = [];
				if (byte === LF) {
					out[n++] = CR;
					out[n++] = LF;
					this.#lineStart = true;
					continue;
				}
				this.bareLineBreaks++;
				out[n++] = CR;
				this.#lineStart = false;
				i--;
				continue;
			}
			if (byte === CR) {
				this.#held = [CR];
				continue;
			}
			if (byte === DOT && this.#lineStart) {
				this.#held = [DOT];
				continue;
			}
			if (byte === LF) this.bareLineBreaks++;
			out[n++] = byte;
			this.#lineStart = false;
		}
		this.#size += n;
		return { data: out.subarray(0, n), done: false, rest: new Uint8Array(0) };
	}
}
