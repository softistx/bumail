/**
 * A raw SMTP session for the checks no client library makes: what EHLO
 * offers before and after STARTTLS, and what AUTH in clear is answered.
 */
import net from 'node:net';
import tls from 'node:tls';

export class SmtpProbe {
	#socket: net.Socket;
	#text = '';
	#waiters: (() => void)[] = [];

	private constructor(socket: net.Socket) {
		this.#socket = socket;
		this.#listen();
	}

	static async connect(port: number): Promise<SmtpProbe> {
		const socket = net.connect({ host: 'localhost', port });
		await new Promise<void>((resolve, reject) => {
			socket.once('connect', resolve);
			socket.once('error', reject);
		});
		return new SmtpProbe(socket);
	}

	#listen(): void {
		this.#socket.on('data', (chunk: Buffer) => {
			this.#text += chunk.toString('latin1');
			for (const waiter of this.#waiters.splice(0)) waiter();
		});
		this.#socket.on('error', () => {});
	}

	/** One whole reply, every line of it (`250-…` up to `250 …`). */
	async reply(ms = 5000): Promise<string[]> {
		const deadline = Date.now() + ms;
		for (;;) {
			const lines = this.#text.split('\r\n');
			const last = lines.findIndex((line) => /^\d{3}( |$)/.test(line));
			if (last >= 0 && last < lines.length - 1) {
				const reply = lines.slice(0, last + 1);
				this.#text = lines.slice(last + 1).join('\r\n');
				return reply;
			}
			const left = deadline - Date.now();
			if (left <= 0) throw new Error(`no reply in ${ms} ms`);
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, left);
				this.#waiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		}
	}

	async send(line: string): Promise<string[]> {
		this.#socket.write(`${line}\r\n`);
		return await this.reply();
	}

	async startTls(ca: string): Promise<void> {
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
		this.#text = '';
		this.#listen();
	}

	close(): void {
		this.#socket.destroy();
	}
}
