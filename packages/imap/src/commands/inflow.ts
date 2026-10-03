import type { Mailbox, Message } from '@bumail/store';
import { sync } from '../mailbox/sync';
import { tagged } from '../protocol/response';
import type { Connection } from '../server/connection';
import { answerFailure } from '../server/failure';
import type { Context } from './context';

/** What an APPEND says before its message (RFC 9051 §6.3.12). */
export interface AppendTarget {
	readonly tag: string;
	readonly mailbox: string;
	readonly flags: readonly string[];
	readonly date?: Date;
}

/** An APPEND whose message streams into the store as it is read. */
export interface AppendStream {
	/** Bytes of the message; resolves when the store can take more. */
	write(bytes: Uint8Array): Promise<void>;
	/** The rest of the line after the message ends the command: empty, or BAD. */
	finish(rest: string): Promise<void>;
	/** The connection closed: nothing is kept. */
	abort(): void;
}

/** The tagged OK to an APPEND, after the selected mailbox's EXISTS when it is the target. */
export async function added(
	context: Pick<Context, 'connection' | 'tag'>,
	mailbox: Mailbox,
): Promise<void> {
	const { connection } = context;
	if (connection.state.selected?.mailboxId === mailbox.id)
		await sync(connection);
	await connection.send(tagged(context.tag, 'OK', 'APPEND completed'));
}

function error(
	controller: ReadableStreamDefaultController<Uint8Array>,
	message: string,
): void {
	try {
		controller.error(new Error(message));
	} catch {
		// Already closed or errored.
	}
}

/**
 * An APPEND's message flowing into the store while it is read: the literal's
 * bytes are queued on a stream `addMessage` reads, and a write waits while
 * 64 KiB at most are queued. Ends with the line after the literal.
 */
export class Inflow implements AppendStream {
	readonly #connection: Connection;
	readonly #target: AppendTarget;
	readonly #mailbox: Mailbox;
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	readonly #adding: Promise<Message>;
	/** Resolves a write waiting for the store to take more. */
	#wake: (() => void) | undefined;
	#stopped = false;

	constructor(
		connection: Connection,
		target: AppendTarget,
		mailbox: Mailbox,
		flags: string[],
		size: number,
	) {
		this.#connection = connection;
		this.#target = target;
		this.#mailbox = mailbox;
		const content = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.#controller = controller;
				},
				pull: () => this.#wake?.(),
				cancel: () => this.#stop(),
			},
			new ByteLengthQueuingStrategy({
				highWaterMark: Math.min(size, 64 * 1024) || 1,
			}),
		);
		this.#adding = connection.settings.store.addMessage(
			connection.accountId,
			mailbox.id,
			{ content, flags, ...(target.date ? { receivedAt: target.date } : {}) },
		);
		this.#adding.catch(() => this.#stop());
	}

	#stop(): void {
		this.#stopped = true;
		this.#wake?.();
	}

	async write(bytes: Uint8Array): Promise<void> {
		if (this.#stopped) return;
		this.#controller.enqueue(bytes);
		if ((this.#controller.desiredSize ?? 1) > 0) return;
		await new Promise<void>((resolve) => {
			this.#wake = resolve;
		});
		this.#wake = undefined;
	}

	async finish(rest: string): Promise<void> {
		const connection = this.#connection;
		const { tag } = this.#target;
		if (rest !== '') {
			error(this.#controller, 'Unexpected text after the message');
			await this.#adding.catch(() => undefined);
			return connection.send(
				tagged(tag, 'BAD', 'Unexpected text after the message'),
			);
		}
		if (!this.#stopped) this.#controller.close();
		try {
			await this.#adding;
		} catch (failure) {
			return answerFailure(connection, tag, failure);
		}
		await added({ connection, tag }, this.#mailbox);
	}

	abort(): void {
		error(this.#controller, 'The connection closed');
		this.#stop();
	}
}
