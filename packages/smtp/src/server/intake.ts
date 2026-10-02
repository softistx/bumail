import { SmtpError } from '../errors';
import { DataReader } from '../protocol/data';
import { type Reply, reply } from '../protocol/reply';
import type { Connection } from './connection';
import { hookTimeout, LOCAL_ERROR, timedOut, within } from './guard';
import type { ReceivedMessage } from './options';
import { receivedField } from './received';
import type { Transaction } from './state';

/** Bytes of message the stream holds before the server stops reading the client. */
const HIGH_WATER_MARK = 64 * 1024;

/**
 * One message on its way in: the content of DATA, unstuffed, fed to
 * `onData` as a stream while the client sends it. The stream holds
 * `HIGH_WATER_MARK` bytes at most; past that the server waits for `onData`
 * to read, and so stops reading the client.
 *
 * The stream ends in an `SmtpError` when the message must not be
 * delivered — too big, a bare CR or LF (SMTP smuggling), the client gone —
 * and the reply to DATA is then the refusal, whatever `onData` answered.
 * The 250 goes out only when the stream ended cleanly and `onData`
 * resolved without a refusal.
 */
export class Intake {
	readonly id = crypto.getRandomValues(new Uint8Array(10)).toHex();
	readonly #connection: Connection;
	readonly #reader = new DataReader();
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	#state: 'open' | 'closed' | 'errored' | 'dropped' = 'open';
	#failure: Reply | undefined;
	#wakers: (() => void)[] = [];
	readonly #delivery: Promise<Reply | undefined>;
	#delivered = false;

	constructor(connection: Connection, transaction: Transaction) {
		this.#connection = connection;
		const content = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.#controller = controller;
				},
				pull: () => this.#wake(),
				cancel: () => {
					if (this.#state === 'open') this.#state = 'dropped';
					this.#wake();
				},
			},
			{
				highWaterMark: HIGH_WATER_MARK,
				size: (chunk) => chunk?.byteLength ?? 0,
			},
		);
		this.#controller.enqueue(
			new TextEncoder().encode(
				receivedField(connection, transaction.to, this.id),
			),
		);
		const message: ReceivedMessage = {
			id: this.id,
			envelope: {
				from: transaction.from ?? '',
				to: [...transaction.to],
				smtputf8: transaction.smtputf8,
				body: transaction.body,
			},
			content,
		};
		const { options } = connection.settings;
		this.#delivery = connection
			.hook('onData', () => options.onData(message, connection.session), false)
			.finally(() => {
				this.#delivered = true;
				this.#wake();
			});
	}

	/** A chunk of DATA; resolves once the stream has room for the next. */
	async write(chunk: Uint8Array): Promise<{ done: boolean; rest: Uint8Array }> {
		const { data, done, rest } = this.#reader.write(chunk);
		const { maxMessageSize } = this.#connection.settings;
		if (this.#failure) return { done, rest };
		if (this.#reader.size > maxMessageSize) {
			this.#fail(
				reply(552, '5.3.4', 'Message too big for system'),
				new SmtpError(
					'MESSAGE_TOO_BIG',
					`The message is larger than maxMessageSize (${maxMessageSize} bytes); do not deliver it`,
				),
			);
		} else if (this.#reader.bareLineBreaks > 0) {
			// A bare CR or LF is how SMTP smuggling hides a second message.
			this.#fail(
				reply(550, '5.6.11', 'Bare CR or LF is not allowed in a message'),
				new SmtpError(
					'BARE_LINE_BREAK',
					'The message holds a bare CR or LF (SMTP smuggling); do not deliver it',
				),
			);
		} else if (this.#state === 'open' && data.length > 0) {
			this.#controller.enqueue(data);
			await this.#room();
		}
		return { done, rest };
	}

	/** The end of DATA: the reply to send. */
	async finish(): Promise<Reply> {
		if (this.#failure) return this.#failure;
		if (this.#state === 'open') {
			this.#state = 'closed';
			this.#controller.close();
		}
		const { hookTimeout: seconds } = this.#connection.settings;
		const answer = await within(this.#delivery, seconds);
		if (timedOut(answer)) {
			this.#connection.report(hookTimeout('onData', seconds));
			return LOCAL_ERROR;
		}
		return answer ?? reply(250, '2.0.0', `OK queued as ${this.id}`);
	}

	/** The client went away mid-message. */
	abort(): void {
		this.#fail(
			LOCAL_ERROR,
			new SmtpError(
				'CONNECTION_LOST',
				'The client disconnected before the end of the message; do not deliver it',
			),
		);
	}

	#fail(answer: Reply, error: SmtpError): void {
		this.#failure ??= answer;
		if (this.#state === 'open') this.#controller.error(error);
		this.#state = 'errored';
		this.#wake();
	}

	/** Waits while the stream is full; gives up on an `onData` that stopped reading. */
	async #room(): Promise<void> {
		const { hookTimeout: seconds } = this.#connection.settings;
		while (this.#state === 'open' && (this.#controller.desiredSize ?? 1) <= 0) {
			if (this.#delivered) {
				// onData answered without reading to the end: feed it no more.
				this.#state = 'dropped';
				return;
			}
			const woken = await within(
				new Promise<void>((wake) => this.#wakers.push(wake)),
				seconds,
			);
			if (timedOut(woken)) {
				this.#connection.report(hookTimeout('onData', seconds));
				this.#fail(
					LOCAL_ERROR,
					new SmtpError(
						'HOOK_TIMEOUT',
						`onData did not read the message within hookTimeout (${seconds} s); do not deliver it`,
					),
				);
			}
		}
	}

	#wake(): void {
		for (const wake of this.#wakers.splice(0)) wake();
	}
}
