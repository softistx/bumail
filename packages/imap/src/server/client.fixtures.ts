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

	write(text: string): void {
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
