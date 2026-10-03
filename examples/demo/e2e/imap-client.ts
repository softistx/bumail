/**
 * A raw IMAP client for the e2e, on `node:net` and `node:tls`: it sends
 * commands as written and returns the server's lines as they came, so the
 * e2e checks the protocol itself rather than a library's reading of it.
 * Literals (`{n}`) are read whole and kept inline in their line.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface Tagged {
	/** Every untagged (`*`) response before the tagged one, literals inline. */
	readonly untagged: string[];
	/** The tagged line: `A1 OK …`. */
	readonly status: string;
	readonly ok: boolean;
}

export class ImapClient {
	#socket: net.Socket;
	#buffer = Buffer.alloc(0);
	#lines: string[] = [];
	#waiters: (() => void)[] = [];
	#closed = false;
	#tag = 0;

	private constructor(socket: net.Socket) {
		this.#socket = socket;
		this.#listen();
	}

	/** Implicit TLS (port 993), trusting `ca`. */
	static async connectTls(port: number, ca: string): Promise<ImapClient> {
		const socket = tls.connect({ host: 'localhost', port, ca });
		await new Promise<void>((resolve, reject) => {
			socket.once('secureConnect', resolve);
			socket.once('error', reject);
		});
		return new ImapClient(socket);
	}

	/** A clear connection (port 143), for STARTTLS. */
	static async connectPlain(port: number): Promise<ImapClient> {
		const socket = net.connect({ host: 'localhost', port });
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', resolve);
			socket.once('error', reject);
		});
		return new ImapClient(socket);
	}

	/** After `STARTTLS` was answered OK: the same client, now over TLS. */
	async upgrade(ca: string): Promise<void> {
		this.#socket.removeAllListeners('data');
		const secure = tls.connect({
			socket: this.#socket,
			servername: 'localhost',
			ca,
		});
		await new Promise<void>((resolve, reject) => {
			secure.once('secureConnect', resolve);
			secure.once('error', reject);
		});
		this.#socket = secure;
		this.#buffer = Buffer.alloc(0);
		this.#listen();
	}

	#listen(): void {
		this.#socket.on('data', (chunk: Buffer) => {
			this.#buffer = Buffer.concat([this.#buffer, chunk]);
			this.#parse();
		});
		this.#socket.on('close', () => {
			this.#closed = true;
			this.#wake();
		});
		this.#socket.on('error', () => {});
	}

	/** Splits the buffer into responses: a line, and any literal it announces. */
	#parse(): void {
		let line = '';
		let at = 0;
		for (;;) {
			const end = this.#buffer.indexOf('\r\n', at);
			if (end < 0) return;
			const part = this.#buffer.subarray(at, end).toString('latin1');
			const literal = /\{(\d+)\+?\}$/.exec(part);
			if (literal) {
				const size = Number(literal[1]);
				if (this.#buffer.length < end + 2 + size) return;
				line += `${part}\r\n${this.#buffer.subarray(end + 2, end + 2 + size).toString('utf8')}`;
				at = end + 2 + size;
				continue;
			}
			line += part;
			this.#lines.push(line);
			line = '';
			at = end + 2;
			this.#buffer = this.#buffer.subarray(at);
			at = 0;
			this.#wake();
		}
	}

	#wake(): void {
		for (const waiter of this.#waiters.splice(0)) waiter();
	}

	/** The next line from the server, or throws after `ms`. */
	async line(ms = 5000): Promise<string> {
		const deadline = Date.now() + ms;
		while (this.#lines.length === 0) {
			if (this.#closed) throw new Error('the server closed the connection');
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no line from the server in ${ms} ms`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, left);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
		return this.#lines.shift() as string;
	}

	write(text: string | Uint8Array): void {
		this.#socket.write(text);
	}

	/**
	 * Sends a command and reads to its tagged reply. A `literal` is sent as
	 * a synchronizing literal after the text, once the server says `+`.
	 */
	async command(text: string, literal?: string): Promise<Tagged> {
		const tag = `A${++this.#tag}`;
		const untagged: string[] = [];
		if (literal === undefined) {
			this.write(`${tag} ${text}\r\n`);
		} else {
			const bytes = new TextEncoder().encode(literal);
			this.write(`${tag} ${text} {${bytes.length}}\r\n`);
			for (;;) {
				const next = await this.line();
				if (next.startsWith('+')) break;
				if (next.startsWith(`${tag} `)) {
					return { untagged, status: next, ok: false };
				}
				untagged.push(next);
			}
			this.write(bytes);
			this.write('\r\n');
		}
		for (;;) {
			const next = await this.line();
			if (next.startsWith(`${tag} `)) {
				return { untagged, status: next, ok: next.startsWith(`${tag} OK`) };
			}
			untagged.push(next);
		}
	}

	/** Sends IDLE and waits for the server's `+`; `done` ends it. */
	async idle(): Promise<{ done(): Promise<Tagged> }> {
		const tag = `A${++this.#tag}`;
		this.write(`${tag} IDLE\r\n`);
		const first = await this.line();
		if (!first.startsWith('+')) throw new Error(`IDLE refused: ${first}`);
		return {
			done: async () => {
				this.write('DONE\r\n');
				const untagged: string[] = [];
				for (;;) {
					const next = await this.line();
					if (next.startsWith(`${tag} `)) {
						return { untagged, status: next, ok: next.startsWith(`${tag} OK`) };
					}
					untagged.push(next);
				}
			},
		};
	}

	close(): void {
		this.#socket.destroy();
	}
}
