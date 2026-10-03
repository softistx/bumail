import { reply } from '../protocol/reply';
import { runCommand } from './commands';
import type { Connection } from './connection';
import { Intake } from './intake';
import { LineSplitter } from './lines';
import { emptyTransaction } from './state';

/** Bytes waiting to be read past which the server stops reading the client. */
const INPUT_LIMIT = 64 * 1024;

/**
 * What a client sends, read in order: command lines one at a time, each
 * answered before the next runs, and the message after DATA. It holds a
 * bounded amount: past `INPUT_LIMIT` waiting bytes it pauses the socket,
 * and it waits for the replies to leave before reading on.
 */
export class Input {
	readonly #connection: Connection;
	#input: Uint8Array[] = [];
	#queued = 0;
	#paused = false;
	readonly #lines = new LineSplitter();
	#intake: Intake | undefined;
	/** A message whole, while `onData` answers it and before the reply is sent. */
	#answering: Intake | undefined;
	/** The work in progress on what the client sent; settled when all of it is answered. */
	#pumping: Promise<void> | undefined;
	/** The 220 went out: input before it breaks RFC 5321 §4.3.1. */
	#greeted = false;
	/** The client talked before the greeting. */
	early = false;
	/** Set while the 220 to STARTTLS leaves: clear text then is never read. */
	#ignoring = false;
	/** Set by `drop`: the line loop drops what it still holds. */
	#dropped = false;

	constructor(connection: Connection) {
		this.#connection = connection;
	}

	greeted(): void {
		this.#greeted = true;
	}

	receive(chunk: Uint8Array): void {
		if (this.#ignoring) return;
		if (!this.#greeted) {
			this.early = true;
			return;
		}
		this.#input.push(chunk.slice());
		this.#queued += chunk.length;
		if (this.#queued > INPUT_LIMIT && !this.#paused) {
			this.#paused = true;
			this.#connection.transport.pause();
		}
		this.#kick();
	}

	/** The connection closed: a message on its way in must not be delivered. */
	abort(): void {
		this.#intake?.abort();
		this.#intake = undefined;
		// The connection closed before the reply, so the client will send the
		// message again: onData learns it through the signal.
		this.#answering?.abort();
		this.#answering = undefined;
	}

	/**
	 * Forgets what the client sent ahead and reads nothing until `accept`:
	 * what comes in clear before TLS never counts (RFC 3207 §4.2,
	 * CVE-2011-0411).
	 */
	ignore(): void {
		this.drop();
		this.#input = [];
		this.#queued = 0;
		this.#ignoring = true;
		this.#resume();
	}

	accept(): void {
		this.#ignoring = false;
	}

	/** Drops the rest of the chunk being read: after a refused DATA, it is message content, not commands. */
	drop(): void {
		this.#lines.clear();
		this.#dropped = true;
	}

	/** Starts receiving a message: `onData` is called, and gets it as it comes. */
	beginData(): void {
		const connection = this.#connection;
		this.#intake = new Intake(connection, connection.state.transaction);
		connection.state.waiting = 'data';
	}

	/** Resolves once everything received so far is answered. */
	async idle(): Promise<void> {
		while (this.#pumping) await this.#pumping;
	}

	#kick(): void {
		if (this.#pumping) return;
		const connection = this.#connection;
		this.#pumping = this.#pump()
			.catch((error) => {
				connection.report(error);
				connection.close(reply(421, '4.3.0', 'Local error, closing'));
			})
			.finally(() => {
				this.#pumping = undefined;
				// Bytes that came after the loop's last look.
				if (!connection.closed && this.#input.length > 0) this.#kick();
			});
	}

	#resume(): void {
		if (this.#paused && this.#queued <= INPUT_LIMIT / 2) {
			this.#paused = false;
			this.#connection.transport.resume();
		}
	}

	async #pump(): Promise<void> {
		while (!this.#connection.closed && this.#input.length > 0) {
			const chunk = this.#input.shift() as Uint8Array;
			this.#queued -= chunk.length;
			this.#resume();
			if (this.#connection.state.waiting === 'data') await this.#data(chunk);
			else await this.#commands(chunk);
		}
	}

	async #commands(chunk: Uint8Array): Promise<void> {
		this.#lines.push(chunk);
		while (!this.#connection.closed) {
			// The replies so far leave before the next command runs.
			await this.#connection.transport.drained();
			const event = this.#lines.next();
			if (!event) return;
			if (!('line' in event)) {
				this.#connection.fail(reply(500, '5.5.6', 'Line too long'));
				continue;
			}
			this.#dropped = false;
			await runCommand(this.#connection, event.line);
			if (this.#dropped) return;
			if (this.#connection.state.waiting === 'data') {
				// Message content pipelined right after DATA.
				const rest = this.#lines.takeRest();
				if (rest.length > 0) this.#unshift(rest.slice());
				return;
			}
		}
	}

	async #data(chunk: Uint8Array): Promise<void> {
		const intake = this.#intake as Intake;
		const { done, rest } = await intake.write(chunk);
		if (!done || this.#connection.closed) return;
		this.#intake = undefined;
		this.#answering = intake;
		this.#connection.state.waiting = 'command';
		this.#connection.state.transaction = emptyTransaction();
		const answer = await intake.finish();
		this.#answering = undefined;
		this.#connection.send(answer);
		if (rest.length > 0) this.#unshift(rest);
	}

	/** Puts bytes back at the front, counted again: the pump took them off the count. */
	#unshift(bytes: Uint8Array): void {
		this.#input.unshift(bytes);
		this.#queued += bytes.length;
		if (this.#queued > INPUT_LIMIT && !this.#paused) {
			this.#paused = true;
			this.#connection.transport.pause();
		}
	}
}
