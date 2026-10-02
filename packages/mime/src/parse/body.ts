import { join } from '../encoding/bytes';
import type { MimeEvent, PartInfo } from './types';

/**
 * The body bytes of one part, gathered into one event per `write`. Lines
 * next to each other in one chunk stay one piece, so a write holds a few
 * views of its chunk, not one array per line.
 */
export class BodyGatherer {
	#part: PartInfo | undefined;
	#pieces: Uint8Array[] = [];

	/** Pieces held: a spec's measure of the bound. */
	get pieces(): number {
		return this.#pieces.length;
	}

	/** Adds body bytes of `part`; returns the event of the part before, if it changed. */
	add(part: PartInfo, data: Uint8Array): MimeEvent | undefined {
		const flushed = this.#part !== part ? this.flush() : undefined;
		this.#part = part;
		const last = this.#pieces[this.#pieces.length - 1];
		if (
			last &&
			last.buffer === data.buffer &&
			last.byteOffset + last.length === data.byteOffset
		) {
			this.#pieces[this.#pieces.length - 1] = new Uint8Array(
				data.buffer,
				last.byteOffset,
				last.length + data.length,
			);
		} else {
			this.#pieces.push(data);
		}
		return flushed;
	}

	/** The gathered bytes as one event, copied out of the caller's chunks. */
	flush(): MimeEvent | undefined {
		const part = this.#part;
		if (!part) return undefined;
		const data = join(this.#pieces);
		this.#part = undefined;
		this.#pieces = [];
		return { type: 'body', part, data };
	}
}
