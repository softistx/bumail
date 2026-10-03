import { LineReader, type ReaderEvent } from '../protocol/reader';
import { Assembler } from './assembler';
import type { Connection } from './connection';
import { MAX_LINE } from './settings';

/** Bytes waiting to be read past which the server stops reading the client. */
const INPUT_LIMIT = 256 * 1024;

/**
 * What a client sends, read in order: command lines and their literals,
 * each command answered before the next runs, and the lines IDLE and
 * AUTHENTICATE wait for. It holds a bounded amount: past `INPUT_LIMIT`
 * waiting bytes it pauses the socket until the server catches up.
 */
export class Input {
	readonly #connection: Connection;
	readonly reader = new LineReader(MAX_LINE);
	readonly #commands: Assembler;
	#queue: Uint8Array[] = [];
	#queued = 0;
	#paused = false;
	#pumping: Promise<void> | undefined;
	/** Set by `ignore`: what is left of the chunk being read is dropped. */
	#dropped = false;
	#ignoring = false;
	/** Takes the next line instead of the command reader: IDLE's DONE, a SASL response. */
	#lineHandler: ((line: string) => Promise<void>) | undefined;

	constructor(connection: Connection) {
		this.#connection = connection;
		this.#commands = new Assembler(connection);
	}

	receive(chunk: Uint8Array): void {
		if (this.#ignoring) return;
		this.#queue.push(chunk.slice());
		this.#queued += chunk.length;
		if (this.#queued > INPUT_LIMIT && !this.#paused) {
			this.#paused = true;
			this.#connection.transport.pause();
		}
		this.#kick();
	}

	/** The next line goes to `handler`, not to the command reader. */
	expectLine(handler: (line: string) => Promise<void>): void {
		this.#lineHandler = handler;
	}

	/** The connection closed: a message on its way in must not be kept. */
	abort(): void {
		this.#commands.abort();
	}

	/**
	 * Forgets what the client sent ahead, and reads nothing until `accept`:
	 * what comes in clear behind STARTTLS never counts (RFC 9051 §6.2.1).
	 */
	ignore(): void {
		this.reader.clear();
		this.#commands.abort();
		this.#queue = [];
		this.#queued = 0;
		this.#dropped = true;
		this.#ignoring = true;
		this.#resume();
	}

	accept(): void {
		this.#ignoring = false;
	}

	/** Resolves once everything received so far is answered. */
	async idle(): Promise<void> {
		while (this.#pumping) await this.#pumping;
	}

	#kick(): void {
		if (this.#pumping) return;
		const connection = this.#connection;
		this.#pumping = this.#pump()
			.catch(async (error) => {
				connection.report(error);
				await connection.close('Internal error, closing');
			})
			.finally(() => {
				this.#pumping = undefined;
				if (!connection.closed && this.#queue.length > 0) this.#kick();
			});
	}

	#resume(): void {
		if (this.#paused && this.#queued <= INPUT_LIMIT / 2) {
			this.#paused = false;
			this.#connection.transport.resume();
		}
	}

	async #pump(): Promise<void> {
		const connection = this.#connection;
		while (!connection.closed && this.#queue.length > 0) {
			const chunk = this.#queue.shift() as Uint8Array;
			this.#queued -= chunk.length;
			this.#resume();
			this.reader.push(chunk);
			this.#dropped = false;
			while (!connection.closed && !this.#dropped) {
				const event = this.reader.next();
				if (!event) break;
				await this.#event(event);
			}
		}
	}

	async #event(event: ReaderEvent): Promise<void> {
		if (event.type === 'data') {
			return this.#commands.data(event.bytes, event.last);
		}
		const handler = this.#lineHandler;
		if (handler) {
			this.#lineHandler = undefined;
			return handler(event.type === 'line' ? event.text : '');
		}
		if (event.type === 'too-long') return this.#commands.tooLong(event);
		return this.#commands.line(event.text, event.literal);
	}
}
