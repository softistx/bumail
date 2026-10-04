import { connect as netConnect, type Socket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';

/** A line client over a real socket, plain or TLS, able to upgrade to TLS. */
export class LineClient {
	#socket: Socket | TLSSocket;
	#buffer = '';
	#waiters: (() => void)[] = [];
	closed = false;

	private constructor(socket: Socket | TLSSocket) {
		this.#socket = socket;
		this.#listen(socket);
	}

	#listen(socket: Socket | TLSSocket): void {
		socket.on('data', (chunk: Buffer) => {
			this.#buffer += chunk.toString('utf8');
			this.#wake();
		});
		socket.on('close', () => {
			this.closed = true;
			this.#wake();
		});
		socket.on('error', () => {});
	}

	#wake(): void {
		for (const wake of this.#waiters.splice(0)) wake();
	}

	static connect(port: number, secure = false): Promise<LineClient> {
		return new Promise((resolve, reject) => {
			const socket = secure
				? tlsConnect({
						host: '127.0.0.1',
						port,
						rejectUnauthorized: false,
						servername: 'localhost',
					})
				: netConnect({ host: '127.0.0.1', port });
			socket.once(secure ? 'secureConnect' : 'connect', () =>
				resolve(new LineClient(socket)),
			);
			socket.once('error', reject);
		});
	}

	/** Waits until the text received matches `pattern`, then takes it up to the match's end. */
	async until(pattern: RegExp, seconds = 10): Promise<string> {
		const end = Date.now() + seconds * 1000;
		for (;;) {
			const match = pattern.exec(this.#buffer);
			if (match) {
				const taken = this.#buffer.slice(0, match.index + match[0].length);
				this.#buffer = this.#buffer.slice(taken.length);
				return taken;
			}
			if (this.closed || Date.now() > end) {
				const rest = this.#buffer;
				this.#buffer = '';
				return rest;
			}
			await Promise.race([
				new Promise<void>((wake) => this.#waiters.push(wake)),
				Bun.sleep(50),
			]);
		}
	}

	/** The next SMTP reply, all its lines. */
	reply(): Promise<string> {
		return this.until(/^(?:\d{3}-[^\n]*\n)*\d{3} [^\n]*\n/);
	}

	write(text: string): void {
		this.#socket.write(text);
	}

	/** Sends an SMTP command, answers its reply. */
	smtp(line: string): Promise<string> {
		this.write(`${line}\r\n`);
		return this.reply();
	}

	/** Sends a tagged IMAP command, answers everything up to its tagged reply. */
	imap(tag: string, command: string): Promise<string> {
		this.write(`${tag} ${command}\r\n`);
		return this.until(new RegExp(`(?:^|\\n)${tag} [^\\n]*\\n`));
	}

	/** Moves the connection to TLS, as after STARTTLS. */
	startTls(): Promise<void> {
		const plain = this.#socket;
		plain.removeAllListeners('data');
		plain.removeAllListeners('close');
		return new Promise((resolve, reject) => {
			const secure = tlsConnect({
				socket: plain as Socket,
				rejectUnauthorized: false,
				servername: 'localhost',
			});
			secure.once('secureConnect', () => {
				this.#socket = secure;
				this.#listen(secure);
				resolve();
			});
			secure.once('error', reject);
		});
	}

	end(): void {
		this.#socket.end();
	}
}

/** An SMTP session through to the end of DATA: answers each reply, the last the one to the message. */
export async function sendMail(
	port: number,
	envelope: { readonly from: string; readonly to: readonly string[] },
	message: string,
	options: { readonly starttls?: boolean; readonly helo?: string } = {},
): Promise<{ replies: string[]; last: string }> {
	const client = await LineClient.connect(port);
	const replies = [await client.reply()];
	const helo = options.helo ?? 'client.example';
	replies.push(await client.smtp(`EHLO ${helo}`));
	if (options.starttls === true) {
		replies.push(await client.smtp('STARTTLS'));
		await client.startTls();
		replies.push(await client.smtp(`EHLO ${helo}`));
	}
	replies.push(await client.smtp(`MAIL FROM:<${envelope.from}>`));
	let accepted = 0;
	for (const to of envelope.to) {
		const answer = await client.smtp(`RCPT TO:<${to}>`);
		replies.push(answer);
		if (answer.startsWith('250')) accepted++;
	}
	let last = replies.at(-1) ?? '';
	if (accepted > 0) {
		replies.push(await client.smtp('DATA'));
		const body = message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..');
		last = await client.smtp(`${body}\r\n.`);
		replies.push(last);
	}
	await client.smtp('QUIT');
	client.end();
	return { replies, last };
}
