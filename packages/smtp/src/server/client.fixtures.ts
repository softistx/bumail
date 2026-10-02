import type { Socket } from 'bun';

/** A line-reading client over a real socket, able to STARTTLS. */
export class Client {
	#socket!: Socket<undefined>;
	#buffer = '';
	#waiters: (() => void)[] = [];
	#encrypted = false;
	#outgoing: Uint8Array[] = [];
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
			drain: () => this.#flush(),
			close: () => {
				this.closed = true;
				for (const wake of this.#waiters.splice(0)) wake();
			},
		};
	}

	/** The next complete reply: lines up to one with a space after the code. */
	async reply(): Promise<string> {
		for (;;) {
			const match = /^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/.exec(this.#buffer);
			if (match) {
				this.#buffer = this.#buffer.slice(match[0].length);
				return match[0];
			}
			if (this.closed) return '';
			await new Promise<void>((wake) => this.#waiters.push(wake));
		}
	}

	async command(line: string): Promise<string> {
		this.#socket.write(`${line}\r\n`);
		return this.reply();
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

	/** Sends text whole, however slowly the server reads it. */
	write(text: string): void {
		this.#outgoing.push(new TextEncoder().encode(text));
		this.#flush();
	}

	#flush(): void {
		while (this.#outgoing.length > 0) {
			const bytes = this.#outgoing[0] as Uint8Array;
			const written = this.#socket.write(bytes);
			if (written < bytes.length) {
				this.#outgoing[0] = bytes.subarray(written);
				return;
			}
			this.#outgoing.shift();
		}
	}

	/** Stops reading what the server sends, as a slow client would. */
	pause(): void {
		this.#socket.pause();
	}

	resume(): void {
		this.#socket.resume();
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

	end(): void {
		this.#socket.end();
	}
}
