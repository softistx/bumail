import type { DataReader } from '../protocol/data';
import { formatReply, type Reply, reply } from '../protocol/reply';
import { runCommand } from './commands';
import { finishData } from './data';
import type { Envelope, HookResult, Session } from './options';
import type { Settings } from './settings';

/** What a connection needs from its socket: Bun's, or a fake one in specs. */
export interface Transport {
	readonly remoteAddress: string;
	readonly secure: boolean;
	write(text: string): void;
	end(): void;
	/** Starts TLS on the connection, after the 220 to STARTTLS. */
	startTls(): void;
}

/** The longest command line taken, CRLF included; RFC 5321 §4.5.3.1.4 asks for 512 at least. */
const MAX_LINE = 2048;

/** A mail transaction in progress (RFC 5321 §3.3). */
export interface Transaction {
	from?: string;
	to: string[];
	smtputf8: boolean;
	body: Envelope['body'];
}

export type Waiting =
	| 'command'
	| 'data'
	| 'auth-plain'
	| 'auth-login-user'
	| 'auth-login-password';

/** The state of a session the commands change. */
export interface State {
	helo?: string | undefined;
	esmtp: boolean;
	user?: string | undefined;
	secure: boolean;
	transaction: Transaction;
	waiting: Waiting;
	loginUser?: string | undefined;
	errors: number;
	authFailures: number;
}

export const emptyTransaction = (): Transaction => ({
	to: [],
	smtputf8: false,
	body: '7BIT',
});

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
	#input: Uint8Array[] = [];
	#buffer: Uint8Array = new Uint8Array(0);
	#discarding = false;
	/** The work in progress on what the client sent; settled when all of it is answered. */
	#pumping: Promise<void> | undefined;
	#closed = false;
	/** Set by `discardInput`: the line loop drops what it still holds. */
	#dropped = false;
	reader?: DataReader | undefined;
	content: Uint8Array[] = [];

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

	close(answer?: Reply): void {
		if (this.#closed) return;
		if (answer) this.send(answer);
		this.#closed = true;
		this.transport.end();
	}

	/** Counts a failed command; past the limit, hangs up. */
	fail(answer: Reply): void {
		this.state.errors++;
		if (this.state.errors >= this.settings.maxErrors) {
			this.close(
				reply(
					421,
					'4.7.0',
					`${this.settings.options.hostname} Too many errors, closing`,
				),
			);
		} else {
			this.send(answer);
		}
	}

	/** Runs a hook; a throw refuses with 451, as a temporary failure. */
	async hook(
		run: () => HookResult | Promise<HookResult>,
	): Promise<Reply | undefined> {
		try {
			return (await run()) ?? undefined;
		} catch {
			return reply(451, '4.3.0', 'Local error in processing');
		}
	}

	/** The greeting, or the refusal of `onConnect`. */
	async open(): Promise<void> {
		const { options } = this.settings;
		const refused = options.onConnect
			? await this.hook(() => options.onConnect?.(this.session))
			: undefined;
		if (refused) this.close(refused);
		else this.send(reply(220, undefined, `${options.hostname} ESMTP ready`));
	}

	/** Bytes from the client; processed in order, after what came before. */
	receive(chunk: Uint8Array): void {
		if (this.#closed) return;
		this.#input.push(chunk.slice());
		this.#kick();
	}

	#kick(): void {
		if (this.#pumping) return;
		this.#pumping = this.#pump()
			.catch(() => {
				this.close(reply(421, '4.3.0', 'Local error, closing'));
			})
			.finally(() => {
				this.#pumping = undefined;
				// Bytes that came after the loop's last look.
				if (!this.#closed && this.#input.length > 0) this.#kick();
			});
	}

	/** Forgets what the client sent ahead: after STARTTLS, nothing sent in clear may count (RFC 3207 §4.2). */
	discardInput(): void {
		this.#input = [];
		this.#buffer = new Uint8Array(0);
		this.#dropped = true;
	}

	/** Resolves once everything received so far is answered. */
	async idle(): Promise<void> {
		while (this.#pumping) await this.#pumping;
	}

	async #pump(): Promise<void> {
		while (!this.#closed && this.#input.length > 0) {
			const chunk = this.#input.shift() as Uint8Array;
			if (this.state.waiting === 'data') await this.#data(chunk);
			else await this.#lines(chunk);
		}
	}

	async #lines(chunk: Uint8Array): Promise<void> {
		let data = this.#buffer.length > 0 ? concat(this.#buffer, chunk) : chunk;
		this.#buffer = new Uint8Array(0);
		while (!this.#closed) {
			const lf = data.indexOf(0x0a);
			if (lf < 0) {
				if (data.length > MAX_LINE) {
					if (!this.#discarding)
						this.fail(reply(500, '5.5.6', 'Line too long'));
					this.#discarding = true;
				} else {
					this.#buffer = data;
				}
				return;
			}
			const end = lf > 0 && data[lf - 1] === 0x0d ? lf - 1 : lf;
			const line = data.subarray(0, end);
			data = data.subarray(lf + 1);
			if (this.#discarding || line.length > MAX_LINE) {
				if (!this.#discarding) this.fail(reply(500, '5.5.6', 'Line too long'));
				this.#discarding = false;
				continue;
			}
			this.#dropped = false;
			await runCommand(this, new TextDecoder().decode(line));
			if (this.#dropped) return;
			if (this.state.waiting === 'data') {
				// Message content pipelined right after DATA.
				if (data.length > 0) this.#input.unshift(data.slice());
				return;
			}
		}
	}

	async #data(chunk: Uint8Array): Promise<void> {
		const reader = this.reader as DataReader;
		const { data, done, rest } = reader.write(chunk);
		if (reader.size <= this.settings.maxMessageSize) this.content.push(data);
		if (!done) return;
		this.state.waiting = 'command';
		await finishData(this);
		if (rest.length > 0) this.#input.unshift(rest);
	}
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
	const out = new Uint8Array(a.length + b.length);
	out.set(a, 0);
	out.set(b, a.length);
	return out;
}
