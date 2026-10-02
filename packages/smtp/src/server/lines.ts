/** The longest command line taken, CRLF included; RFC 5321 §4.5.3.1.4 asks for 512 at least. */
export const MAX_LINE = 2048;

/** One line from the client, or a line that was too long and was skipped. */
export type LineEvent = { line: string } | { tooLong: true };

/**
 * Cuts the client's bytes into command lines, ending at LF with or without
 * CR. It holds one partial line at most: past `MAX_LINE`, the line is
 * skipped to its end and reported once.
 */
export class LineSplitter {
	#held: Uint8Array = new Uint8Array(0);
	#skipping = false;
	#rest: Uint8Array = new Uint8Array(0);

	/** Starts on a chunk; read its lines with `next`. */
	push(chunk: Uint8Array): void {
		this.#rest = this.#held.length > 0 ? concat(this.#held, chunk) : chunk;
		this.#held = new Uint8Array(0);
	}

	/** The next line of the current chunk, or `undefined` when it has no more. */
	next(): LineEvent | undefined {
		for (;;) {
			const data = this.#rest;
			const lf = data.indexOf(0x0a);
			if (lf < 0) {
				this.#rest = new Uint8Array(0);
				if (this.#skipping) return undefined;
				if (data.length > MAX_LINE) {
					this.#skipping = true;
					return { tooLong: true };
				}
				this.#held = data.slice();
				return undefined;
			}
			const end = lf > 0 && data[lf - 1] === 0x0d ? lf - 1 : lf;
			this.#rest = data.subarray(lf + 1);
			if (this.#skipping) {
				this.#skipping = false;
				continue;
			}
			if (end > MAX_LINE) return { tooLong: true };
			return { line: new TextDecoder().decode(data.subarray(0, end)) };
		}
	}

	/** What is left of the current chunk: message content pipelined after DATA. */
	takeRest(): Uint8Array {
		const rest = this.#rest;
		this.#rest = new Uint8Array(0);
		return rest;
	}

	/** Forgets everything held: after STARTTLS, or after a refused DATA. */
	clear(): void {
		this.#held = new Uint8Array(0);
		this.#rest = new Uint8Array(0);
		this.#skipping = false;
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
