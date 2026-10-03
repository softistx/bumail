import type { Selected } from '../mailbox/selected';
import { type Piece, untagged } from '../protocol/response';
import { capabilities } from './capabilities';
import { Input } from './input';
import type { ImapSession } from './options';
import type { Settings } from './settings';
import type { Transport } from './transport';

/** RFC 9051 §3: where a session is. */
export type Phase =
	| 'not-authenticated'
	| 'authenticated'
	| 'selected'
	| 'logout';

export interface State {
	phase: Phase;
	secure: boolean;
	user?: string;
	accountId?: string;
	/** The client said ENABLE IMAP4rev2: UTF-8 names, ESEARCH, no RECENT. */
	rev2: boolean;
	selected?: Selected | undefined;
	authFailures: number;
}

/** Backlog past which a writer waits for the socket to take what it holds. */
const HIGH_WATER = 64 * 1024;

/** How much of a Blob is read and written at a time. */
const SLICE = 64 * 1024;

const encoder = new TextEncoder();

/**
 * One IMAP session: its state, what it writes, and the hooks it runs.
 * Commands run one at a time, in the order they came (`Input`); a look at
 * the store during IDLE takes the same turn through `exclusive`.
 */
export class Connection {
	readonly settings: Settings;
	#transport: Transport;
	readonly id = crypto.getRandomValues(new Uint8Array(8)).toHex();
	readonly data: Record<string, unknown> = {};
	readonly state: State;
	readonly input: Input;
	#closed = false;
	#turn: Promise<unknown> = Promise.resolve();
	#loginTimer: ReturnType<typeof setTimeout> | undefined;
	/** Stops IDLE's polling, when the session idles. */
	stopIdle: (() => void) | undefined;
	/** Wakes IDLE to look at the store now. */
	wake: (() => void) | undefined;

	constructor(settings: Settings, transport: Transport) {
		this.settings = settings;
		this.#transport = transport;
		this.state = {
			phase: 'not-authenticated',
			secure: transport.secure,
			rev2: false,
			authFailures: 0,
		};
		this.input = new Input(this);
	}

	get transport(): Transport {
		return this.#transport;
	}

	/** After STARTTLS: writes and hang-ups go through the encrypted socket. */
	useTransport(transport: Transport): void {
		this.#transport = transport;
	}

	get session(): ImapSession {
		const { user, accountId, secure } = this.state;
		return {
			id: this.id,
			remoteAddress: this.transport.remoteAddress,
			secure,
			...(user === undefined ? {} : { user }),
			...(accountId === undefined ? {} : { accountId }),
			data: this.data,
		};
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** The account logged in; only called past the not-authenticated state. */
	get accountId(): string {
		return this.state.accountId as string;
	}

	/**
	 * Writes pieces in order. A Blob is read and written 64 KiB at a time,
	 * and the writer waits for the socket whenever it holds more than
	 * 64 KiB: a client that reads slowly holds the server back, never its
	 * memory — what waits for it is a slice, not a message.
	 */
	async send(pieces: readonly Piece[]): Promise<void> {
		for (const piece of pieces) {
			if (this.#closed) return;
			if (typeof piece === 'string')
				this.transport.write(encoder.encode(piece));
			else if (piece instanceof Uint8Array) this.transport.write(piece);
			else {
				for (let at = 0; at < piece.size; at += SLICE) {
					const slice = piece.slice(at, at + SLICE);
					const bytes = new Uint8Array(await slice.arrayBuffer());
					if (this.#closed) return;
					this.transport.write(bytes);
					await this.#calm();
				}
			}
		}
		await this.#calm();
	}

	async #calm(): Promise<void> {
		if (this.transport.backlog > HIGH_WATER) await this.transport.drained();
	}

	untagged(text: string): Promise<void> {
		return this.send(untagged(text));
	}

	/**
	 * Says BYE, when given a reason, and hangs up. It never waits on the
	 * client: the BYE is queued behind what the client has not read, and the
	 * transport hangs up within its grace even if none of it leaves. A
	 * `forced` close — a timeout — drops what is queued and hangs up now.
	 */
	close(bye?: string, { forced = false } = {}): Promise<void> {
		if (this.#closed) return Promise.resolve();
		this.#closed = true;
		this.state.phase = 'logout';
		clearTimeout(this.#loginTimer);
		this.stopIdle?.();
		this.input.abort();
		const transport = this.transport;
		if (forced && transport.backlog > 0) transport.abort();
		else {
			if (bye) transport.write(encoder.encode(`* BYE ${bye}\r\n`));
			transport.end();
		}
		return Promise.resolve();
	}

	/** Hands an error to `onError`, which may not throw back. */
	report(error: unknown): void {
		try {
			this.settings.options.onError?.(error, this.session);
		} catch {
			// The app's error handler failing is not the client's business.
		}
	}

	/** Runs `work` once everything before it is done: a command, or a look during IDLE. */
	exclusive<T>(work: () => Promise<T>): Promise<T> {
		const run = this.#turn.then(work, work);
		this.#turn = run.catch(() => undefined);
		return run;
	}

	/** The greeting, and the time the client has to log in. */
	async open(): Promise<void> {
		const { hostname } = this.settings.options;
		this.#loginTimer = setTimeout(() => {
			if (this.state.phase === 'not-authenticated') {
				void this.close('Too slow to log in, closing', { forced: true });
			}
		}, this.settings.loginTimeout * 1000);
		await this.untagged(
			`OK [CAPABILITY ${capabilities(this).join(' ')}] ${hostname} IMAP4rev2 ready`,
		);
	}

	/** Logged in: the login time no longer runs. */
	loggedIn(user: string, accountId: string): void {
		clearTimeout(this.#loginTimer);
		this.state.user = user;
		this.state.accountId = accountId;
		this.state.phase = 'authenticated';
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
