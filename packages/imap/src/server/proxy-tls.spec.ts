import { afterEach, describe, expect, test } from 'bun:test';
import { Client, localhostTls, slowTlsReader } from './client.fixtures';
import { front } from './front.fixtures';
import type { ImapServerOptions } from './options';
import { v1, v2 } from './proxy/headers.fixtures';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';
import { CLOSE_GRACE_MS } from './transport';

let server: ImapServer | undefined;
const clients: Client[] = [];
const fronts: { close(): void }[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.end();
	for (const proxy of fronts.splice(0)) proxy.close();
	server?.stop(true);
	server = undefined;
});

/** Implicit TLS behind a trusted proxy, and who `authenticate` saw. */
async function start(overrides: Partial<ImapServerOptions> = {}) {
	const { store, accountId, inbox } = await seededStore();
	const seen: string[] = [];
	const errors: unknown[] = [];
	const fixtures = new URL('./fixtures/', import.meta.url);
	server = createImapServer(
		imapOptions(store, accountId, {
			// A BunFile, which the TLS behind a proxy reads as Bun.listen would.
			tls: {
				key: Bun.file(new URL('localhost.key', fixtures)),
				cert: (await localhostTls()).cert,
			},
			implicitTls: true,
			proxyProtocol: { trusted: ['127.0.0.1'] },
			authenticate: (_, session) => {
				seen.push(`${session.remoteAddress} ${session.secure}`);
				return accountId;
			},
			onError: (error) => {
				errors.push(error);
			},
			...overrides,
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, seen, errors, store, accountId, inbox };
}

async function proxy(port: number, header: Uint8Array, coalesce = true) {
	const one = await front(port, header, { coalesce });
	fronts.push(one);
	return one.port;
}

async function through(port: number, header: Uint8Array, coalesce = true) {
	const client = await Client.connect(
		await proxy(port, header, coalesce),
		true,
	);
	clients.push(client);
	return client;
}

async function raw(port: number, first: Uint8Array | string) {
	const client = await Client.connect(port);
	clients.push(client);
	client.write(first);
	return client;
}

async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

describe('implicit TLS behind a trusted proxy', () => {
	test('the header and the ClientHello in one segment: greeted over TLS, the client the source', async () => {
		const { port, seen } = await start();
		const client = await through(port, v2({ source: '198.51.100.7' }));
		expect(await client.line()).toContain('IMAP4rev2 ready');
		expect(await client.command('a', 'LOGIN alice secret')).toStartWith('a OK');
		expect(seen).toEqual(['198.51.100.7 true']);
	});

	test('the header, then the ClientHello on its own', async () => {
		const { port, seen } = await start();
		const client = await through(port, v1('2001:db8::7'), false);
		await client.line();
		await client.command('a', 'LOGIN alice secret');
		expect(seen).toEqual(['2001:db8::7 true']);
	});

	test('a slow reader of a large FETCH gets every byte, then BYE, then the close', async () => {
		const { port, store, accountId, inbox } = await start();
		const line = `${'y'.repeat(998)}\r\n`;
		const content = `Subject: large\r\n\r\n${line.repeat(4096)}`;
		await store.addMessage(accountId, inbox.id, {
			content: new TextEncoder().encode(content),
		});
		const client = slowTlsReader(
			await proxy(port, v2({ source: '198.51.100.7' })),
		);
		await client.waitFor('ready\r\n');
		client.socket.write('a LOGIN alice secret\r\nb SELECT INBOX\r\n');
		await client.waitFor('b OK');
		client.sip();
		client.socket.write('c FETCH 3 BODY.PEEK[]\r\nd LOGOUT\r\n');
		const started = Date.now();
		while (!client.closed && Date.now() - started < 10_000) {
			client.socket.resume();
			await Bun.sleep(50);
		}
		expect(client.closed).toBe(true);
		const text = client.text();
		const body = text.indexOf(`{${content.length}}\r\n${content})\r\n`);
		expect(body).toBeGreaterThan(0);
		expect(text).toEndWith('* BYE Logging out\r\nd OK LOGOUT completed\r\n');
		expect(Date.now() - (client.lastDataAt ?? 0)).toBeLessThan(CLOSE_GRACE_MS);
		expect(await counted(0)).toBe(0);
	}, 15_000);

	test('maxConnections counts it once its handshake began, turned away over TLS', async () => {
		const { port } = await start({ maxConnections: 1 });
		const first = await through(port, v1('198.51.100.1'));
		await first.line();
		const second = await through(port, v1('198.51.100.2'));
		expect(await second.line()).toBe(
			'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
		);
	});

	test('a ClientHello that never comes: counted, then closed at handshakeTimeout', async () => {
		const { port } = await start({ handshakeTimeout: 1 });
		const client = await raw(port, v2({ source: '198.51.100.7' }));
		expect(await counted(1)).toBe(1);
		// Bun's socket timer ticks in steps of about 4 s.
		expect(await counted(0, 7)).toBe(0);
		expect(client.received).toBe('');
	}, 12_000);

	test('garbage where the ClientHello should be: counted out at once', async () => {
		const { port, errors } = await start();
		const client = await raw(port, v2({ source: '198.51.100.7' }));
		client.write('a CAPABILITY\r\n');
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(await counted(0)).toBe(0);
		expect(errors).toEqual([]);
	});

	test('stop(true) with a handshake pending behind its header: reset, nothing written', async () => {
		const { port, errors } = await start();
		const client = await raw(port, v1('198.51.100.7'));
		expect(await counted(1)).toBe(1);
		expect(() => server?.stop(true)).not.toThrow();
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(client.received).toBe('');
		expect(errors).toEqual([]);
	});
});

describe('implicit TLS with proxyProtocol, from a peer not trusted', () => {
	test('a TLS client straight to the port is served as without it', async () => {
		const { port, seen } = await start({
			proxyProtocol: { trusted: ['192.0.2.1'] },
		});
		const client = await Client.connect(port, true);
		clients.push(client);
		expect(await client.line()).toContain('IMAP4rev2 ready');
		await client.command('a', 'LOGIN alice secret');
		expect(seen).toEqual(['127.0.0.1 true']);
	});

	test('a header from it is no ClientHello: closed, never greeted', async () => {
		const { port, seen } = await start({
			proxyProtocol: { trusted: ['192.0.2.1'] },
		});
		const client = await raw(port, v1('198.51.100.7'));
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(seen).toEqual([]);
		expect(await counted(0)).toBe(0);
	});
});
