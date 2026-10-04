import { connect, type Socket as NetSocket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import type { Socket } from 'bun';

/** An IMAP client over a real socket, able to STARTTLS; adapted from `@bumail/smtp`'s spec client. */
export class Client {
	#socket!: Socket<undefined>;
	#buffer = '';
	#waiters: (() => void)[] = [];
	#encrypted = false;
	/** Every byte the server sent, as text. */
	received = '';
	closed = false;

	static async connect(port: number, secure = false): Promise<Client> {
		const client = new Client();
		client.#socket = await Bun.connect({
			hostname: '127.0.0.1',
			port,
			...(secure
				? { tls: { rejectUnauthorized: false, serverName: 'localhost' } }
				: {}),
			socket: client.#handler(),
		});
		return client;
	}

	#handler(tls = false) {
		return {
			data: (_: Socket<undefined>, chunk: Uint8Array) => {
				// After STARTTLS, the clear socket sees the TLS records themselves.
				if (this.#encrypted !== tls) return;
				const text = new TextDecoder().decode(chunk);
				this.#buffer += text;
				this.received += text;
				for (const wake of this.#waiters.splice(0)) wake();
			},
			close: () => {
				this.closed = true;
				for (const wake of this.#waiters.splice(0)) wake();
			},
		};
	}

	/** Waits for text matching `pattern` at the start of the buffer, and takes it. */
	async #take(pattern: RegExp): Promise<string> {
		for (;;) {
			const match = pattern.exec(this.#buffer);
			if (match) {
				const end = match.index + match[0].length;
				const taken = this.#buffer.slice(0, end);
				this.#buffer = this.#buffer.slice(end);
				return taken;
			}
			if (this.closed) {
				const rest = this.#buffer;
				this.#buffer = '';
				return rest;
			}
			await new Promise<void>((wake) => this.#waiters.push(wake));
		}
	}

	/** The next line the server sends. */
	line(): Promise<string> {
		return this.#take(/\r\n/);
	}

	/** Everything up to and including the tagged answer to `tag`. */
	answer(tag: string): Promise<string> {
		return this.#take(
			new RegExp(`(?:^|\\r\\n)${tag} (?:OK|NO|BAD)[^\\r]*\\r\\n`),
		);
	}

	/** Sends `tag line` and waits for its tagged answer. */
	async command(tag: string, line: string): Promise<string> {
		this.write(`${tag} ${line}\r\n`);
		return this.answer(tag);
	}

	write(text: string | Uint8Array): void {
		this.#socket.write(text);
	}

	startTls(): Promise<void> {
		this.#encrypted = true;
		return new Promise((done, fail) => {
			const [, encrypted] = this.#socket.upgradeTLS({
				tls: { rejectUnauthorized: false, serverName: 'localhost' },
				socket: {
					...this.#handler(true),
					handshake: (_, ok, error) => (ok ? done() : fail(error)),
				},
			});
			this.#socket = encrypted;
		});
	}

	/** Waits until what the server sent passes `check`, for `seconds` at most. */
	async until(
		check: (received: string) => boolean,
		seconds = 5,
	): Promise<boolean> {
		const end = Date.now() + seconds * 1000;
		while (!check(this.received)) {
			if (this.closed || Date.now() > end) return check(this.received);
			await Promise.race([
				new Promise<void>((wake) => this.#waiters.push(wake)),
				Bun.sleep(50),
			]);
		}
		return true;
	}

	/** Stops reading what the server sends, as a client that never reads. */
	pause(): void {
		this.#socket.pause();
	}

	/** Reads again after `pause`. */
	resume(): void {
		this.#socket.resume();
	}

	end(): void {
		this.#socket.end();
	}
}

const fixtures = new URL('./fixtures/', import.meta.url);

/** The self-signed key and certificate for `localhost` the specs serve TLS with. */
export async function localhostTls() {
	return {
		key: await Bun.file(new URL('localhost.key', fixtures)).text(),
		cert: await Bun.file(new URL('localhost.crt', fixtures)).text(),
	};
}

/** A clear `node:net` socket that has asked STARTTLS and got its OK. */
async function askedStartTls(port: number): Promise<NetSocket> {
	const clear = connect({ host: '127.0.0.1', port });
	let seen = '';
	let asked = false;
	await new Promise<void>((done) => {
		clear.on('data', (chunk: Buffer) => {
			seen += chunk.toString();
			if (!asked && seen.includes('\r\n')) {
				asked = true;
				clear.write('a STARTTLS\r\n');
			}
			if (seen.includes('a OK')) done();
		});
	});
	clear.removeAllListeners('data');
	return clear;
}

/** How a paused client reaches the server. */
export type PausedPath = 'clear' | 'implicit TLS' | 'STARTTLS';

/**
 * A client that stops reading at once — over a clear `node:net` socket,
 * implicit TLS, or STARTTLS on a clear socket first — and never answers
 * the server's close, as a paused or vanished client would not. What the
 * server sends waits in the kernel for it; `resume()` reads it.
 */
export async function pausedClient(
	port: number,
	path: PausedPath,
): Promise<NetSocket> {
	if (path === 'clear') {
		const clear = connect({ host: '127.0.0.1', port });
		clear.pause();
		clear.on('error', () => {});
		await new Promise<void>((done) => clear.once('connect', done));
		return clear;
	}
	const options = { rejectUnauthorized: false, servername: 'localhost' };
	const secure: TLSSocket = tlsConnect(
		path === 'STARTTLS'
			? { ...options, socket: await askedStartTls(port) }
			: { ...options, host: '127.0.0.1', port },
	);
	secure.on('error', () => {});
	await new Promise<void>((done) => secure.once('secureConnect', done));
	secure.pause();
	return secure;
}

/**
 * A `node:tls` client on implicit TLS that keeps every byte it gets. After
 * `sip`, it takes one chunk each time it is resumed, then pauses again: a
 * client reading slowly, so the server's queue fills behind it.
 */
export function slowTlsReader(port: number) {
	const socket = tlsConnect({
		host: '127.0.0.1',
		port,
		rejectUnauthorized: false,
		servername: 'localhost',
	});
	const chunks: Buffer[] = [];
	let sipping = false;
	const reader = {
		socket,
		closed: false,
		lastDataAt: undefined as number | undefined,
		text: () => Buffer.concat(chunks).toString('latin1'),
		async waitFor(text: string): Promise<void> {
			while (!reader.text().includes(text) && !reader.closed)
				await Bun.sleep(5);
		},
		sip(): void {
			sipping = true;
			socket.pause();
		},
	};
	socket.on('error', () => {});
	socket.on('data', (chunk: Buffer) => {
		chunks.push(chunk);
		reader.lastDataAt = Date.now();
		if (sipping) socket.pause();
	});
	socket.on('close', () => {
		reader.closed = true;
	});
	return reader;
}
