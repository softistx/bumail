import type { SmtpError } from '../errors';
import { DataReader } from '../protocol/data';
import { type Reply, reply } from '../protocol/reply';
import type { Connection } from './connection';
import { hookTimeout, LOCAL_ERROR, refusalOf, timedOut, within } from './guard';
import type { ReceivedMessage } from './options';
import { receivedField } from './received';
import {
	BARE_LINE_BREAK,
	bareLineBreak,
	connectionLost,
	notAnswered,
	notRead,
	notReadInTime,
	TOO_BIG,
	tooBig,
} from './refusals';
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
 * Whenever the message is refused for a reason `onData` did not answer
 * itself — the stream failed, it timed out, threw, answered what is not a
 * refusal, did not read to the end, or the client left before the reply —
 * the message's `signal` aborts with the reason, even once the stream had
 * ended cleanly.
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
	/** Whether `onData` had read to the end when it answered. */
	#readWhenAnswered = false;
	/** Aborts when the server refuses the message after `onData` had it. */
	readonly #refusal = new AbortController();

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
			signal: this.#refusal.signal,
		};
		this.#delivery = this.#deliver(message);
	}

	/**
	 * `onData`'s answer as the reply: `undefined`, its refusal, or 451 when
	 * it threw or answered what is not a refusal — which also aborts the
	 * signal, since the message was not taken.
	 */
	async #deliver(message: ReceivedMessage): Promise<Reply | undefined> {
		const connection = this.#connection;
		const refuse = (error: unknown) => {
			this.#refusal.abort(error);
			connection.report(error);
		};
		try {
			const answer = await connection.settings.options.onData(
				message,
				connection.session,
			);
			return refusalOf('onData', answer, refuse);
		} catch (error) {
			refuse(error);
			return LOCAL_ERROR;
		} finally {
			this.#readWhenAnswered = this.#read;
			// Answered before the end: the client will hear 451 and send it
			// again, so a reader left running must not reach a clean end.
			if (!this.#read) this.#stop();
			this.#wake();
		}
	}

	/** A chunk of DATA; resolves once there is room for the next. */
	async write(chunk: Uint8Array): Promise<{ done: boolean; rest: Uint8Array }> {
		const { data, done, rest } = this.#reader.write(chunk);
		const { maxMessageSize } = this.#connection.settings;
		if (this.#failure) return { done, rest };
		if (this.#reader.size > maxMessageSize) {
			this.#fail(TOO_BIG, tooBig(maxMessageSize));
		} else if (this.#reader.bareLineBreaks > 0) {
			// A bare CR or LF is how SMTP smuggling hides a second message.
			this.#fail(BARE_LINE_BREAK, bareLineBreak());
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
			// The client is told 451 and will try again: a late read must not
			// take it, and a read already finished learns it through the signal.
			this.#fail(LOCAL_ERROR, notAnswered(seconds));
			return LOCAL_ERROR;
		}
		if (answer) return answer;
		if (!this.#readWhenAnswered) {
			const error = notRead();
			this.#refusal.abort(error);
			this.#connection.report(error);
			return LOCAL_ERROR;
		}
		return reply(250, '2.0.0', `OK queued as ${this.id}`);
	}

	/** The client went away, mid-message or before hearing the reply. */
	abort(): void {
		this.#fail(LOCAL_ERROR, connectionLost(this.#ended));
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

	/** onData answered without reading to the end: the stream errors, and takes no more. */
	#stop(): void {
		if (this.#state !== 'open') return;
		const error = notRead();
		this.#refusal.abort(error);
		this.#controller.error(error);
		this.#state = 'cancelled';
		this.#queue = [];
		this.#queued = 0;
	}

	#fail(answer: Reply, error: SmtpError): void {
		this.#failure ??= answer;
		this.#refusal.abort(error);
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
			const woken = await within(
				new Promise<void>((wake) => this.#wakers.push(wake)),
				seconds,
			);
			if (timedOut(woken)) {
				this.#connection.report(hookTimeout('onData', seconds));
				this.#fail(LOCAL_ERROR, notReadInTime(seconds));
			}
		}
	}

	#wake(): void {
		for (const wake of this.#wakers.splice(0)) wake();
	}
}
