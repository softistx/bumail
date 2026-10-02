import { SmtpError } from '../errors';
import { DataReader } from '../protocol/data';
import { type Reply, reply } from '../protocol/reply';
import type { Connection } from './connection';
import { hookTimeout, LOCAL_ERROR, timedOut, within } from './guard';
import type { ReceivedMessage } from './options';
import { receivedField } from './received';
import type { Transaction } from './state';

/** Bytes of message held for `onData` before the server stops reading the client. */
const HIGH_WATER_MARK = 64 * 1024;

/**
 * One message on its way in: the content of DATA, unstuffed, fed to
 * `onData` as a stream while the client sends it. At most
 * `HIGH_WATER_MARK` bytes wait to be read; past that the server waits for
 * `onData` to read, and so stops reading the client.
 *
 * The stream ends in an `SmtpError` when the message must not be
 * delivered — too big, a bare CR or LF (SMTP smuggling), the client gone —
 * and the reply to DATA is then the refusal, whatever `onData` answered.
 * The 250 goes out only when `onData` read the stream to its clean end and
 * resolved without a refusal: an `onData` that answers before the end, or
 * cancels the stream, gets `451 4.3.0` and a `MESSAGE_NOT_READ` report.
 */
export class Intake {
	readonly id = crypto.getRandomValues(new Uint8Array(10)).toHex();
	readonly #connection: Connection;
	readonly #reader = new DataReader();
	#controller!: ReadableStreamDefaultController<Uint8Array>;
	/** What waits for `onData` to pull. */
	#queue: Uint8Array[] = [];
	#queued = 0;
	/** The end of DATA came, cleanly. */
	#ended = false;
	/** `onData` pulled the last byte and saw the stream close. */
	#read = false;
	#state: 'open' | 'closed' | 'errored' | 'cancelled' = 'open';
	#failure: Reply | undefined;
	#wakers: (() => void)[] = [];
	readonly #delivery: Promise<Reply | undefined>;
	#delivered = false;
	/** Whether `onData` had read to the end when it answered. */
	#readWhenAnswered = false;

	constructor(connection: Connection, transaction: Transaction) {
		this.#connection = connection;
		// High-water mark 0: a byte leaves the queue only when onData asks
		// for it, so the server knows whether it read to the end.
		const content = new ReadableStream<Uint8Array>(
			{
				start: (controller) => {
					this.#controller = controller;
				},
				pull: (controller) => this.#pull(controller),
				cancel: () => {
					if (this.#state === 'open') this.#state = 'cancelled';
					this.#queue = [];
					this.#queued = 0;
					this.#wake();
				},
			},
			{ highWaterMark: 0 },
		);
		this.#push(
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
				this.#readWhenAnswered = this.#read;
				this.#delivered = true;
				this.#wake();
			});
	}

	/** A chunk of DATA; resolves once there is room for the next. */
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
			this.#push(data);
			await this.#room();
		}
		return { done, rest };
	}

	/** The end of DATA: the reply to send. */
	async finish(): Promise<Reply> {
		if (this.#failure) return this.#failure;
		this.#ended = true;
		this.#wake();
		const { hookTimeout: seconds } = this.#connection.settings;
		const answer = await within(this.#delivery, seconds);
		if (timedOut(answer)) {
			this.#connection.report(hookTimeout('onData', seconds));
			// The client is told 451 and will try again: a late read must not take it.
			this.#fail(
				LOCAL_ERROR,
				new SmtpError(
					'HOOK_TIMEOUT',
					`onData did not answer within hookTimeout (${seconds} s); do not deliver it`,
				),
			);
			return LOCAL_ERROR;
		}
		if (answer) return answer;
		if (!this.#readWhenAnswered) {
			this.#connection.report(
				new SmtpError(
					'MESSAGE_NOT_READ',
					'onData answered without reading the message to its end; it was not taken',
				),
			);
			return LOCAL_ERROR;
		}
		return reply(250, '2.0.0', `OK queued as ${this.id}`);
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

	#push(bytes: Uint8Array): void {
		this.#queue.push(bytes);
		this.#queued += bytes.length;
		this.#wake();
	}

	/** onData asks for more: the next chunk, the end, or a wait for either. */
	async #pull(
		controller: ReadableStreamDefaultController<Uint8Array>,
	): Promise<void> {
		for (;;) {
			if (this.#state !== 'open') return;
			const next = this.#queue.shift();
			if (next) {
				this.#queued -= next.length;
				controller.enqueue(next);
				this.#wake();
				return;
			}
			if (this.#ended) {
				this.#read = true;
				this.#state = 'closed';
				controller.close();
				return;
			}
			await new Promise<void>((wake) => this.#wakers.push(wake));
		}
	}

	#fail(answer: Reply, error: SmtpError): void {
		this.#failure ??= answer;
		if (this.#state === 'open') this.#controller.error(error);
		this.#state = 'errored';
		this.#queue = [];
		this.#queued = 0;
		this.#wake();
	}

	/** Waits while the queue is full; gives up on an `onData` that stopped reading. */
	async #room(): Promise<void> {
		const { hookTimeout: seconds } = this.#connection.settings;
		while (this.#state === 'open' && this.#queued > HIGH_WATER_MARK) {
			if (this.#delivered) {
				// onData answered without reading to the end: feed it no more.
				this.#controller.error(
					new SmtpError(
						'MESSAGE_NOT_READ',
						'onData answered without reading the message to its end; it was not taken',
					),
				);
				this.#state = 'cancelled';
				this.#queue = [];
				this.#queued = 0;
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
