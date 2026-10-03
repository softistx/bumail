/** A literal announced at the end of a line: `{n}` waits for `+`, `{n+}` does not (RFC 7888). */
export interface LiteralMarker {
	readonly size: number;
	readonly sync: boolean;
}

/**
 * What the reader cut from the client's bytes:
 * - a whole line, without its line break, with the literal it announces;
 * - a line longer than the limit, skipped to its end: only its start
 *   (for the tag) and the literal its end announces are kept;
 * - bytes of a literal, once `expectLiteral` asked for them.
 */
export type ReaderEvent =
	| {
			readonly type: 'line';
			readonly text: string;
			readonly literal?: LiteralMarker;
	  }
	| {
			readonly type: 'too-long';
			readonly head: string;
			readonly literal?: LiteralMarker;
	  }
	| {
			readonly type: 'data';
			readonly bytes: Uint8Array;
			readonly last: boolean;
	  };

/** How much of a skipped line's start is kept, for its tag. */
const HEAD = 64;
/** How much of a skipped line's end is kept, for its literal marker. */
const TAIL = 24;

const decoder = new TextDecoder();

/**
 * The literal a line announces at its end: `{digits}` or `{digits+}`. At
 * most 10 digits, so the size stays an exact number; read from the end
 * without a regular expression, in time linear in the marker.
 */
export function literalMarker(line: string): LiteralMarker | undefined {
	if (!line.endsWith('}')) return undefined;
	let end = line.length - 1;
	const sync = line[end - 1] !== '+';
	if (!sync) end--;
	let start = end;
	while (start > 0 && start > end - 11) {
		const char = line.charCodeAt(start - 1);
		if (char < 0x30 || char > 0x39) break;
		start--;
	}
	if (start === end || end - start > 10 || line[start - 1] !== '{') {
		return undefined;
	}
	return { size: Number(line.slice(start, end)), sync };
}

/**
 * Cuts what a client sends into lines and literal bytes. It holds one
 * partial line of at most `maxLine` bytes: past that, the line is skipped
 * to its end and reported once, with its head and tail.
 */
export class LineReader {
	readonly #maxLine: number;
	#held: Uint8Array[] = [];
	#heldSize = 0;
	#rest: Uint8Array = new Uint8Array(0);
	#skipping: { head: Uint8Array; tail: Uint8Array } | undefined;
	/** Bytes of a literal still to come. */
	#literal = 0;

	constructor(maxLine: number) {
		this.#maxLine = maxLine;
	}

	push(chunk: Uint8Array): void {
		this.#rest = this.#rest.length === 0 ? chunk : concat([this.#rest, chunk]);
	}

	/** The next `size` bytes are a literal: `next` gives them as `data`. */
	expectLiteral(size: number): void {
		this.#literal = size;
	}

	/** Bytes of a literal still to come. */
	get literalLeft(): number {
		return this.#literal;
	}

	/** Forgets everything held: after STARTTLS, nothing sent before counts. */
	clear(): void {
		this.#held = [];
		this.#heldSize = 0;
		this.#rest = new Uint8Array(0);
		this.#skipping = undefined;
		this.#literal = 0;
	}

	next(): ReaderEvent | undefined {
		if (this.#literal > 0) return this.#data();
		const data = this.#rest;
		const lf = data.indexOf(0x0a);
		if (lf < 0) {
			this.#rest = new Uint8Array(0);
			this.#hold(data);
			return undefined;
		}
		this.#rest = data.subarray(lf + 1);
		this.#hold(data.subarray(0, lf));
		return this.#endLine();
	}

	#data(): ReaderEvent | undefined {
		if (this.#rest.length === 0) return undefined;
		const take = Math.min(this.#literal, this.#rest.length);
		const bytes = this.#rest.subarray(0, take);
		this.#rest = this.#rest.subarray(take);
		this.#literal -= take;
		return { type: 'data', bytes, last: this.#literal === 0 };
	}

	/** Keeps part of a line; past `maxLine`, only its head and tail. */
	#hold(bytes: Uint8Array): void {
		if (bytes.length === 0) return;
		if (!this.#skipping && this.#heldSize + bytes.length > this.#maxLine) {
			const line = concat([...this.#held, bytes]);
			this.#skipping = {
				head: line.slice(0, HEAD),
				tail: line.slice(-TAIL),
			};
			this.#held = [];
			this.#heldSize = 0;
			return;
		}
		if (this.#skipping) {
			const tail = concat([this.#skipping.tail, bytes]);
			this.#skipping.tail = tail.slice(-TAIL);
			return;
		}
		this.#held.push(bytes.slice());
		this.#heldSize += bytes.length;
	}

	#endLine(): ReaderEvent {
		const skipped = this.#skipping;
		this.#skipping = undefined;
		if (skipped) {
			const tail = withoutCr(decoder.decode(skipped.tail));
			const literal = literalMarker(tail);
			return {
				type: 'too-long',
				head: decoder.decode(skipped.head),
				...(literal ? { literal } : {}),
			};
		}
		const text = withoutCr(decoder.decode(concat(this.#held)));
		this.#held = [];
		this.#heldSize = 0;
		const literal = literalMarker(text);
		return { type: 'line', text, ...(literal ? { literal } : {}) };
	}
}

function withoutCr(text: string): string {
	return text.endsWith('\r') ? text.slice(0, -1) : text;
}

export function concat(parts: readonly Uint8Array[]): Uint8Array {
	if (parts.length === 1) return parts[0] as Uint8Array;
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
