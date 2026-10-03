import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from './client.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

async function start(overrides = {}) {
	const received: string[] = [];
	server = createSmtpServer(
		mxOptions({
			tls,
			authenticate: ({ username, password }) =>
				username === 'alice' && password === 'secret',
			onData: async (message) => {
				received.push(await new Response(message.content).text());
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
		expect(received[0] ?? '').toEndWith('Subject: hi\r\n\r\nhello\r\n');
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
		expect(received[0] ?? '').toContain('with ESMTPSA id');
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

	test('the idle time starts again with every command', async () => {
		const { port } = await start({ timeout: 2 });
		const client = await Client.connect(port);
		await client.reply();
		for (let i = 0; i < 7; i++) {
			expect(await client.command('NOOP')).toBe('250 OK\r\n');
			await Bun.sleep(500);
		}
		expect(client.closed).toBe(false);
		client.end();
	}, 10_000);

	test('a client that reads slowly loses no reply', async () => {
		const { port } = await start();
		const client = await Client.connect(port);
		await client.reply();
		await client.command('EHLO bar.com');
		const count = 100_000;
		client.pause();
		client.write('NOOP\r\n'.repeat(count));
		await Bun.sleep(300);
		client.resume();
		const all = await client.until(
			(text) => text.split('250 2.0.0 OK\r\n').length - 1 === count,
			10,
		);
		expect(all).toBe(true);
		client.end();
	}, 15_000);

	test('a session that went through STARTTLS is counted out when it closes', async () => {
		const { port } = await start();
		const client = await Client.connect(port);
		await client.reply();
		await client.command('EHLO bar.com');
		await client.command('STARTTLS');
		await client.startTls();
		await client.command('EHLO bar.com');
		expect(server?.connections).toBe(1);
		client.end();
		for (let i = 0; i < 50 && server?.connections !== 0; i++)
			await Bun.sleep(20);
		expect(server?.connections).toBe(0);
	});

	test('listen twice throws ALREADY_LISTENING', async () => {
		await start();
		expect(server?.listen({ port: 0, hostname: '127.0.0.1' })).rejects.toThrow(
			'listen(): the server is already listening on 127.0.0.1:',
		);
	});
});
