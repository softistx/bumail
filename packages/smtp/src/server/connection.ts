import { formatReply, type Reply, reply } from '../protocol/reply';
import { hookTimeout, LOCAL_ERROR, refusalOf, timedOut, within } from './guard';
import { Input } from './input';
import type { HookResult, Session } from './options';
import type { Settings } from './settings';
import { emptyTransaction, type State } from './state';
import type { Transport } from './transport';

/**
 * One SMTP session (RFC 5321): reads commands, one at a time and in order —
 * PIPELINING sends several at once, and each reply waits for the hooks of
 * the commands before it — and the message after DATA.
 */
export class Connection {
	readonly settings: Settings;
	#transport: Transport;
	readonly id = crypto.getRandomValues(new Uint8Array(8)).toHex();
	readonly data: Record<string, unknown> = {};
	readonly state: State;
	/** What the client sends: commands, then message content after DATA. */
	readonly input: Input = new Input(this);
	#closed = false;

	constructor(settings: Settings, transport: Transport) {
		this.settings = settings;
		this.#transport = transport;
		this.state = {
			esmtp: false,
			secure: transport.secure,
			transaction: emptyTransaction(),
			waiting: 'command',
			errors: 0,
			authFailures: 0,
		};
	}

	get transport(): Transport {
		return this.#transport;
	}

	/** After STARTTLS: writes and hang-ups go through the encrypted socket. */
	useTransport(transport: Transport): void {
		this.#transport = transport;
	}

	get session(): Session {
		const { helo, user } = this.state;
		return {
			id: this.id,
			remoteAddress: this.transport.remoteAddress,
			secure: this.state.secure,
			esmtp: this.state.esmtp,
			...(helo === undefined ? {} : { helo }),
			...(user === undefined ? {} : { user }),
			data: this.data,
		};
	}

	get closed(): boolean {
		return this.#closed;
	}

	send(answer: Reply): void {
		if (this.#closed) return;
		this.transport.write(formatReply(answer, this.state.esmtp));
	}

	/**
	 * Hangs up, the server's decision (a refusal, too many errors, the idle
	 * time): `answer` is written, but nothing waits for a client that
	 * stopped reading. The connection is closed at once, and what it has
	 * not read is dropped, so a close always completes.
	 */
	close(answer?: Reply): void {
		if (this.#closed) return;
		if (answer) this.send(answer);
		this.#closed = true;
		this.input.abort();
		this.transport.abort();
	}

	/** QUIT: `answer` leaves whole, then the connection hangs up. */
	quit(answer: Reply): void {
		if (this.#closed) return;
		this.send(answer);
		this.#closed = true;
		this.input.abort();
		this.transport.end();
	}

	/** Counts a failed command; past the limit, hangs up. */
	fail(answer: Reply): void {
		this.state.errors++;
		if (this.state.errors >= this.settings.maxErrors) {
			const { hostname } = this.settings.options;
			this.close(reply(421, '4.7.0', `${hostname} Too many errors, closing`));
		} else {
			this.send(answer);
		}
	}

	/** Hands an error to `onError`, which may not throw back. */
	report(error: unknown): void {
		try {
			this.settings.options.onError?.(error, this.session);
		} catch {
			// The app's error handler failing is not the client's business.
		}
	}

	/**
	 * Runs a hook: its refusal, or `undefined`. A throw, a reply that is not
	 * a refusal, or — with `deadline` — no answer within `hookTimeout` is
	 * reported and answered `451 4.3.0`.
	 */
	async hook(
		name: string,
		run: () => HookResult | Promise<HookResult>,
		deadline = true,
	): Promise<Reply | undefined> {
		const answer = await this.check(name, run, deadline);
		if (answer.failed) return LOCAL_ERROR;
		return refusalOf(name, answer.value, (error) => this.report(error));
	}

	/** Runs app code that answers a value: `failed` when it threw or timed out, which is reported. */
	async check<T>(
		name: string,
		run: () => T | Promise<T>,
		deadline = true,
	): Promise<{ failed: false; value: T } | { failed: true }> {
		const seconds = this.settings.hookTimeout;
		try {
			const running = Promise.resolve().then(run);
			const value = deadline ? await within(running, seconds) : await running;
			if (timedOut(value)) {
				this.report(hookTimeout(name, seconds));
				return { failed: true };
			}
			return { failed: false, value };
		} catch (error) {
			this.report(error);
			return { failed: true };
		}
	}

	/** The greeting, or the refusal of `onConnect`, or of a client that talked first. */
	async open(): Promise<void> {
		const { options } = this.settings;
		const refused = options.onConnect
			? await this.hook('onConnect', () => options.onConnect?.(this.session))
			: undefined;
		if (refused) return this.close(refused);
		const { greetingDelay } = this.settings;
		if (greetingDelay > 0) await Bun.sleep(greetingDelay * 1000);
		if (this.#closed) return;
		if (this.input.early) {
			// RFC 5321 §4.3.1: the client waits for the greeting; a spammer often does not.
			return this.close(
				reply(554, '5.5.0', `${options.hostname} Talked before the greeting`),
			);
		}
		this.send(reply(220, undefined, `${options.hostname} ESMTP ready`));
		// The client's idle time starts at the greeting, not at connect: what
		// greetingDelay and onConnect took is not taken from it.
		this.transport.restartIdle(this.settings.timeout);
		this.input.greeted();
	}

	/** Bytes from the client; processed in order, after what came before. */
	receive(chunk: Uint8Array): void {
		if (!this.#closed) this.input.receive(chunk);
	}

	/** Resolves once everything received so far is answered. */
	idle(): Promise<void> {
		return this.input.idle();
	}
}
