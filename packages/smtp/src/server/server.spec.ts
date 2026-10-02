import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import type { ReceivedMessage } from './options';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

/** A line-reading client over a real socket, able to STARTTLS. */
class Client {
	#socket!: Socket<undefined>;
	#buffer = '';
	#waiters: (() => void)[] = [];
	#encrypted = false;
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
				this.#buffer += new TextDecoder().decode(chunk);
				for (const wake of this.#waiters.splice(0)) wake();
			},
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

	end(): void {
		this.#socket.end();
	}
}

let server: SmtpServer | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

async function start(overrides = {}) {
	const received: ReceivedMessage[] = [];
	server = createSmtpServer(
		mxOptions({
			tls,
			authenticate: ({ username, password }) =>
				username === 'alice' && password === 'secret',
			onData: (message) => {
				received.push(message);
			},
			...overrides,
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, received };
}

const plain = new TextEncoder().encode('\0alice\0secret').toBase64();

describe('createSmtpServer on Bun.listen', () => {
	test('receives a message over a real socket', async () => {
		const { port, received } = await start();
		const client = await Client.connect(port);
		expect(await client.reply()).toBe('220 foo.com ESMTP ready\r\n');
		await client.command('EHLO bar.com');
		await client.command('MAIL FROM:<a@bar.com>');
		await client.command('RCPT TO:<b@foo.com>');
		expect(await client.command('DATA')).toStartWith('354');
		expect(await client.command('Subject: hi\r\n\r\nhello\r\n.')).toStartWith(
			'250 2.0.0 OK queued as',
		);
		expect(await client.command('QUIT')).toStartWith('221');
		expect(received).toHaveLength(1);
		expect(new TextDecoder().decode(received[0]?.content)).toEndWith(
			'Subject: hi\r\n\r\nhello\r\n',
		);
	});

	test('STARTTLS, then AUTH, then a relayed message (RFC 3207, RFC 4954)', async () => {
		const { port, received } = await start();
		const client = await Client.connect(port);
		await client.reply();
		const clear = await client.command('EHLO bar.com');
		expect(clear).toContain('STARTTLS');
		expect(clear).not.toContain('AUTH');
		expect(await client.command(`AUTH PLAIN ${plain}`)).toStartWith(
			'538 5.7.11',
		);
		expect(await client.command('STARTTLS')).toBe(
			'220 2.0.0 Ready to start TLS\r\n',
		);
		await client.startTls();
		const secure = await client.command('EHLO bar.com');
		expect(secure).toContain('AUTH PLAIN LOGIN');
		expect(secure).not.toContain('STARTTLS');
		expect(await client.command(`AUTH PLAIN ${plain}`)).toStartWith('235');
		await client.command('MAIL FROM:<alice@foo.com>');
		expect(
			await client.command('RCPT TO:<friend@elsewhere.example>'),
		).toStartWith('250');
		await client.command('DATA');
		expect(await client.command('hi\r\n.')).toStartWith('250');
		client.end();
		expect(new TextDecoder().decode(received[0]?.content)).toContain(
			'with ESMTPSA id',
		);
	});

	test('without AUTH, the real server refuses to relay', async () => {
		const { port } = await start();
		const client = await Client.connect(port);
		await client.reply();
		await client.command('EHLO bar.com');
		await client.command('MAIL FROM:<a@bar.com>');
		expect(await client.command('RCPT TO:<victim@elsewhere.example>')).toBe(
			'554 5.7.1 Relay access denied\r\n',
		);
		client.end();
	});

	test('implicit TLS (RFC 8314): encrypted from the first byte, AUTH offered at once', async () => {
		const { port } = await start({ implicitTls: true, mode: 'submission' });
		const client = await Client.connect(port, true);
		expect(await client.reply()).toStartWith('220');
		const ehlo = await client.command('EHLO bar.com');
		expect(ehlo).toContain('AUTH PLAIN LOGIN');
		expect(ehlo).not.toContain('STARTTLS');
		expect(await client.command(`AUTH PLAIN ${plain}`)).toStartWith('235');
		client.end();
	});

	test('maxConnections: one more is turned away with 421', async () => {
		const { port } = await start({ maxConnections: 1 });
		const first = await Client.connect(port);
		await first.reply();
		const second = await Client.connect(port);
		expect(await second.reply()).toBe(
			'421 4.3.2 foo.com Too many connections, try later\r\n',
		);
		expect(server?.connections).toBe(1);
		first.end();
	});

	test('timeout: an idle client is told 421 and let go', async () => {
		const { port } = await start({ timeout: 1 });
		const client = await Client.connect(port);
		await client.reply();
		expect(await client.reply()).toBe('421 foo.com Idle too long, closing\r\n');
	}, 8000);
});
