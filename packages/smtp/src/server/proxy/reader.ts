import { MAX_HEADER_LENGTH, readProxyHeader } from './header';

/**
 * Reads the PROXY header a trusted proxy sends first, chunk by chunk, within
 * `seconds` from the TCP connection, however slowly it comes. `done` gets
 * the client's address (`undefined` to keep the peer's) and what followed
 * the header; `refuse` is called for a header that is malformed, too long
 * or too late. Either is called once, and the reader then ignores input.
 */
export class HeaderReader {
	#bytes = new Uint8Array(0);
	#timer: ReturnType<typeof setTimeout> | undefined;
	#settled = false;
	readonly #done: (source: string | undefined, rest: Uint8Array) => void;
	readonly #refuse: () => void;

	constructor(
		seconds: number,
		done: (source: string | undefined, rest: Uint8Array) => void,
		refuse: () => void,
	) {
		this.#done = done;
		this.#refuse = refuse;
		this.#timer = setTimeout(() => this.#settle(refuse), seconds * 1000);
		this.#timer.unref?.();
	}

	receive(chunk: Uint8Array): void {
		if (this.#settled) return;
		const bytes = new Uint8Array(this.#bytes.length + chunk.length);
		bytes.set(this.#bytes);
		bytes.set(chunk, this.#bytes.length);
		this.#bytes = bytes;
		const header = readProxyHeader(bytes);
		if (header.status === 'complete') {
			const rest = bytes.slice(header.length);
			this.#settle(() => this.#done(header.source, rest));
		} else if (
			header.status === 'invalid' ||
			bytes.length >= MAX_HEADER_LENGTH
		) {
			this.#settle(this.#refuse);
		}
	}

	/** The socket closed first: no timer is left behind. */
	cancel(): void {
		this.#settled = true;
		clearTimeout(this.#timer);
		this.#bytes = new Uint8Array(0);
	}

	#settle(then: () => void): void {
		if (this.#settled) return;
		this.cancel();
		then();
	}
}
