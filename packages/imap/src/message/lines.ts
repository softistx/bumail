/** One line of a message, as the structure scanner sees it. */
export interface Line {
	/** Where the line starts in the message. */
	readonly offset: number;
	/** Its length, line break included. */
	readonly length: number;
	/** Its first bytes, line break excluded: all of it unless `truncated`. */
	readonly content: Uint8Array;
	readonly truncated: boolean;
	/** 2 for CRLF, 1 for a bare LF, 0 for a last line without one. */
	readonly breakLength: number;
}

const EMPTY = new Uint8Array(0);

/**
 * Cuts a message into lines as it streams by, keeping at most `keep()`
 * bytes of each — the caller says how much it needs, a header line whole,
 * a body line only far enough to tell a delimiter — so a line of any
 * length costs a bounded buffer.
 */
export class LineSplitter {
	readonly #keep: () => number;
	readonly #line: (line: Line) => void;
	#offset = 0;
	#kept: Uint8Array[] = [];
	#keptSize = 0;
	#length = 0;
	#truncated = false;
	#last = -1;
	#beforeLast = -1;

	constructor(keep: () => number, line: (line: Line) => void) {
		this.#keep = keep;
		this.#line = line;
	}

	/** Bytes read so far. */
	get position(): number {
		return this.#offset + this.#length;
	}

	write(chunk: Uint8Array): void {
		let start = 0;
		while (start < chunk.length) {
			const lf = chunk.indexOf(0x0a, start);
			if (lf < 0) {
				this.#add(chunk.subarray(start));
				return;
			}
			this.#add(chunk.subarray(start, lf + 1));
			this.#emit(true);
			start = lf + 1;
		}
	}

	/** The end of the message: a last line without a line break is emitted. */
	end(): void {
		if (this.#length > 0) this.#emit(false);
	}

	#add(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		const room = this.#keep() - this.#keptSize;
		if (room > 0) {
			const take = Math.min(room, bytes.length);
			this.#kept.push(bytes.slice(0, take));
			this.#keptSize += take;
		}
		if (bytes.length > Math.max(room, 0)) this.#truncated = true;
		this.#length += bytes.length;
		this.#beforeLast =
			bytes.length > 1 ? (bytes[bytes.length - 2] as number) : this.#last;
		this.#last = bytes[bytes.length - 1] as number;
	}

	#emit(ended: boolean): void {
		const breakLength = !ended ? 0 : this.#beforeLast === 0x0d ? 2 : 1;
		const whole =
			this.#kept.length === 1
				? (this.#kept[0] as Uint8Array)
				: join(this.#kept);
		const contentLength = this.#truncated
			? whole.length
			: Math.max(0, whole.length - breakLength);
		this.#line({
			offset: this.#offset,
			length: this.#length,
			content: whole.length === 0 ? EMPTY : whole.subarray(0, contentLength),
			truncated: this.#truncated,
			breakLength,
		});
		this.#offset += this.#length;
		this.#kept = [];
		this.#keptSize = 0;
		this.#length = 0;
		this.#truncated = false;
		this.#last = -1;
		this.#beforeLast = -1;
	}
}

export function join(parts: readonly Uint8Array[]): Uint8Array {
	let size = 0;
	for (const part of parts) size += part.length;
	const out = new Uint8Array(size);
	let at = 0;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}
