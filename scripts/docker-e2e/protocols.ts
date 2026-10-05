/**
 * The mail protocols the Docker end-to-end speaks, as raw sockets
 * (`node:net` and `node:tls`): SMTP with STARTTLS and AUTH, and IMAP over
 * TLS, so the e2e checks what the server sends, not a library's reading
 * of it. A certificate is never verified here: the e2e checks who issued
 * it (`peerCertificate`) instead, since the CA is Pebble's and new each run.
 */
import net from 'node:net';
import tls from 'node:tls';

export interface Reply {
	readonly code: number;
	/** Every line of the reply, as sent. */
	readonly lines: string[];
}

/** A socket read line by line, which can be upgraded to TLS. */
class Lines {
	#socket: net.Socket;
	#buffer = '';
	#lines: string[] = [];
	#waiting: (() => void) | undefined;
	#ended = false;

	constructor(socket: net.Socket) {
		this.#socket = socket;
		this.#attach(socket);
	}

	#attach(socket: net.Socket): void {
		socket.setEncoding('utf8');
		socket.on('data', (chunk: string) => {
			this.#buffer += chunk;
			let end = this.#buffer.indexOf('\r\n');
			while (end !== -1) {
				this.#lines.push(this.#buffer.slice(0, end));
				this.#buffer = this.#buffer.slice(end + 2);
				end = this.#buffer.indexOf('\r\n');
			}
			this.#waiting?.();
		});
		const stop = () => {
			this.#ended = true;
			this.#waiting?.();
		};
		socket.on('close', stop);
		socket.on('error', stop);
	}

	get socket(): net.Socket {
		return this.#socket;
	}

	write(text: string): void {
		this.#socket.write(text);
	}

	async line(timeoutMs = 20_000): Promise<string> {
		const deadline = Date.now() + timeoutMs;
		while (this.#lines.length === 0) {
			if (this.#ended) throw new Error('the connection closed');
			if (Date.now() > deadline)
				throw new Error('timed out waiting for a line');
			await new Promise<void>((resolve) => {
				this.#waiting = resolve;
				setTimeout(resolve, 200);
			});
		}
		return this.#lines.shift() as string;
	}

	/** Replaces the socket with a TLS one over it. */
	async upgrade(servername: string): Promise<void> {
		this.#socket.removeAllListeners('data');
		this.#socket.removeAllListeners('close');
		this.#socket.removeAllListeners('error');
		this.#buffer = '';
		const secure = tls.connect({
			socket: this.#socket,
			servername,
			rejectUnauthorized: false,
		});
		await new Promise<void>((resolve, reject) => {
			secure.once('secureConnect', resolve);
			secure.once('error', reject);
		});
		this.#socket = secure;
		this.#attach(secure);
	}

	close(): void {
		this.#socket.destroy();
	}
}

async function open(
	host: string,
	port: number,
	implicitTls: boolean,
	servername: string,
): Promise<Lines> {
	const socket = implicitTls
		? tls.connect({ host, port, servername, rejectUnauthorized: false })
		: net.connect({ host, port });
	await new Promise<void>((resolve, reject) => {
		socket.once(implicitTls ? 'secureConnect' : 'connect', resolve);
		socket.once('error', reject);
	});
	return new Lines(socket);
}

/** What the peer's certificate says, for the check that the ACME CA issued it. */
export interface Certificate {
	readonly issuer: string;
	readonly subjectaltname: string;
	readonly validTo: string;
}

export function certificateOf(socket: net.Socket): Certificate {
	const peer = (socket as tls.TLSSocket).getPeerCertificate();
	const issuer = Object.values(peer.issuer ?? {}).join(' ');
	return {
		issuer,
		subjectaltname: peer.subjectaltname ?? '',
		validTo: peer.valid_to ?? '',
	};
}

export class Smtp {
	#lines: Lines;
	private constructor(lines: Lines) {
		this.#lines = lines;
	}

	/** Connects; `implicitTls` for port 465. The greeting is read. */
	static async connect(
		host: string,
		port: number,
		options: { implicitTls?: boolean; servername: string },
	): Promise<{ smtp: Smtp; greeting: Reply }> {
		const lines = await open(
			host,
			port,
			options.implicitTls === true,
			options.servername,
		);
		const smtp = new Smtp(lines);
		return { smtp, greeting: await smtp.reply() };
	}

	async reply(): Promise<Reply> {
		const lines: string[] = [];
		for (;;) {
			const line = await this.#lines.line();
			lines.push(line);
			if (line[3] !== '-') return { code: Number(line.slice(0, 3)), lines };
		}
	}

	async command(text: string): Promise<Reply> {
		this.#lines.write(`${text}\r\n`);
		return this.reply();
	}

	async startTls(servername: string): Promise<Reply> {
		const answer = await this.command('STARTTLS');
		if (answer.code === 220) await this.#lines.upgrade(servername);
		return answer;
	}

	get certificate(): Certificate {
		return certificateOf(this.#lines.socket);
	}

	/** `AUTH PLAIN`, answering the reply. */
	async authPlain(user: string, password: string): Promise<Reply> {
		const token = Buffer.from(`\0${user}\0${password}`).toString('base64');
		return this.command(`AUTH PLAIN ${token}`);
	}

	/** MAIL, RCPT and DATA of one message; the reply to the end of the data, or the first refusal. */
	async send(from: string, to: string, message: string): Promise<Reply> {
		const mail = await this.command(`MAIL FROM:<${from}>`);
		if (mail.code !== 250) return mail;
		const rcpt = await this.command(`RCPT TO:<${to}>`);
		if (rcpt.code !== 250) return rcpt;
		const data = await this.command('DATA');
		if (data.code !== 354) return data;
		this.#lines.write(
			`${message.replace(/\r?\n/g, '\r\n').replace(/^\./gm, '..')}\r\n.\r\n`,
		);
		return this.reply();
	}

	async quit(): Promise<void> {
		try {
			await this.command('QUIT');
		} catch {
			// the peer hung up first
		}
		this.#lines.close();
	}
}

export interface ImapResult {
	readonly certificate: Certificate;
	/** Every line the server sent after the greeting, literals included. */
	readonly text: string;
}

/**
 * IMAP over TLS: LOGIN, SELECT INBOX, FETCH every message whole. Answers
 * what the server said, and its certificate.
 */
export async function imapFetchAll(
	host: string,
	port: number,
	user: string,
	password: string,
	servername: string,
): Promise<ImapResult> {
	const lines = await open(host, port, true, servername);
	try {
		await lines.line(); // * OK greeting
		let text = '';
		const run = async (tag: string, command: string) => {
			lines.write(`${tag} ${command}\r\n`);
			for (;;) {
				const line = await lines.line();
				text += `${line}\n`;
				if (line.startsWith(`${tag} `)) {
					if (!line.startsWith(`${tag} OK`)) throw new Error(line);
					return;
				}
			}
		};
		await run('a1', `LOGIN "${user}" "${password}"`);
		await run('a2', 'SELECT INBOX');
		await run('a3', 'FETCH 1:* (BODY.PEEK[])');
		await run('a4', 'LOGOUT');
		return { certificate: certificateOf(lines.socket), text };
	} finally {
		lines.close();
	}
}
