import { afterEach, describe, expect, test } from 'bun:test';
import { ImapError } from '../errors';
import { Client, localhostTls } from './client.fixtures';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';

const servers: ImapServer[] = [];
afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

async function start(overrides: Parameters<typeof imapOptions>[2] = {}) {
	const { store, accountId, inbox } = await seededStore();
	const tls = await localhostTls();
	const server = createImapServer(
		imapOptions(store, accountId, { tls, ...overrides }),
	);
	servers.push(server);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { server, port, store, accountId, inbox };
}

describe('on a real socket', () => {
	test('STARTTLS with the self-signed key, then LOGIN (RFC 9051 §6.2.1)', async () => {
		const { port } = await start();
		const client = await Client.connect(port);
		expect(await client.line()).toContain('STARTTLS LOGINDISABLED');
		expect(await client.command('a1', 'LOGIN alice secret')).toStartWith(
			'a1 NO [PRIVACYREQUIRED]',
		);
		expect(await client.command('a2', 'STARTTLS')).toBe(
			'a2 OK Begin TLS negotiation now\r\n',
		);
		await client.startTls();
		const capability = await client.command('a3', 'CAPABILITY');
		expect(capability).toContain('AUTH=PLAIN');
		expect(capability).not.toContain('LOGINDISABLED');
		expect(await client.command('a4', 'LOGIN alice secret')).toStartWith(
			'a4 OK [CAPABILITY',
		);
		expect(await client.command('a5', 'LOGOUT')).toContain('* BYE');
		expect(await client.until(() => client.closed)).toBe(true);
	});

	test('implicit TLS on 993 (RFC 8314): AUTHENTICATE PLAIN at once, SASL-IR', async () => {
		const { port } = await start({ implicitTls: true });
		const client = await Client.connect(port, true);
		const greeting = await client.line();
		expect(greeting).toContain('AUTH=PLAIN SASL-IR');
		expect(greeting).not.toContain('STARTTLS');
		const plain = new TextEncoder().encode('\0alice\0secret').toBase64();
		expect(
			await client.command('a1', `AUTHENTICATE PLAIN ${plain}`),
		).toStartWith('a1 OK');
		client.end();
	});

	test('maxConnections: one too many gets BYE', async () => {
		const { server, port } = await start({ maxConnections: 1 });
		const first = await Client.connect(port);
		await first.line();
		const second = await Client.connect(port);
		expect(await second.line()).toBe(
			'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
		);
		expect(server.connections).toBe(1);
		first.end();
	});

	test('a client that never logs in is cut at loginTimeout, however much it trickles', async () => {
		const { port } = await start({ loginTimeout: 1 });
		const client = await Client.connect(port);
		await client.line();
		const trickle = setInterval(() => client.write('x'), 100);
		const started = Date.now();
		expect(await client.until(() => client.closed, 5)).toBe(true);
		clearInterval(trickle);
		expect(Date.now() - started).toBeLessThan(3000);
		expect(client.received).toContain('* BYE Too slow to log in, closing');
	});

	test('listen twice throws ALREADY_LISTENING', async () => {
		const { server } = await start();
		expect(server.listen({ port: 0 })).rejects.toThrow(ImapError);
	});
});
