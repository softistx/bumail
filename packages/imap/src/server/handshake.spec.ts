import { afterEach, describe, expect, test } from 'bun:test';
import { connect as netConnect } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { MemoryMailStore } from '@bumail/store';
import type { Socket } from 'bun';
import { Client, localhostTls } from './client.fixtures';
import { handlers } from './listener';
import type { ImapServerOptions } from './options';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';
import { settingsOf } from './settings';

const BYE = '* BYE [UNAVAILABLE] Too many connections, try later\r\n';

let server: ImapServer | undefined;
const sockets: Socket<undefined>[] = [];
const clients: Client[] = [];
const nodeSockets: TLSSocket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.terminate();
	for (const socket of nodeSockets.splice(0)) socket.destroy();
	for (const client of clients.splice(0)) client.end();
	server?.stop(true);
	server = undefined;
});

async function start(overrides: Partial<ImapServerOptions> = {}) {
	const { store, accountId } = await seededStore();
	const tls = await localhostTls();
	server = createImapServer(
		imapOptions(store, accountId, { tls, implicitTls: true, ...overrides }),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return port;
}

/** A plain TCP socket to the implicit-TLS port that never sends a ClientHello, or sends `garbage`. */
async function raw(
	port: number,
	garbage?: string,
): Promise<{ closed: () => boolean; received: () => number }> {
	let closed = false;
	let received = 0;
	const socket = await Bun.connect({
		hostname: '127.0.0.1',
		port,
		socket: {
			data(_, chunk) {
				received += chunk.byteLength;
			},
			close() {
				closed = true;
			},
		},
	});
	sockets.push(socket);
	if (garbage !== undefined) socket.write(garbage);
	return { closed: () => closed, received: () => received };
}

/** A TLS client's first line: the greeting, or a refusal. */
async function tlsClient(port: number): Promise<string> {
	const client = await Client.connect(port, true);
	clients.push(client);
	return client.line();
}

/** Polls `server.connections` until it is `expected`, for `seconds` at most. */
async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

async function closedWithin(socket: { closed: () => boolean }, ms: number) {
	const end = Date.now() + ms;
	while (!socket.closed() && Date.now() < end) await Bun.sleep(20);
	return socket.closed();
}

describe('implicit TLS before the handshake', () => {
	test('a socket that never sends a ClientHello holds a slot of maxConnections, and frees it on closing', async () => {
		const port = await start({ maxConnections: 2 });
		await raw(port);
		const second = await raw(port);
		expect(await counted(2)).toBe(2);
		// The refusal waits for the handshake, so a TLS client reads it.
		expect(await tlsClient(port)).toBe(BYE);
		sockets[1]?.terminate();
		expect(await closedWithin(second, 1000)).toBe(true);
		expect(await counted(1)).toBe(1);
		expect(await tlsClient(port)).toContain('IMAP4rev2 ready');
	});

	test('handshakeTimeout closes it and frees its slot, whatever loginTimeout and timeout', async () => {
		const port = await start({
			maxConnections: 1,
			handshakeTimeout: 1,
			loginTimeout: 600,
		});
		const silent = await raw(port);
		expect(await counted(1)).toBe(1);
		// Bun's socket timer ticks in steps of about 4 s.
		expect(await counted(0, 7)).toBe(0);
		expect(await closedWithin(silent, 1000)).toBe(true);
		expect(await tlsClient(port)).toContain('IMAP4rev2 ready');
	}, 12_000);

	test('a client that completes its handshake is greeted over TLS, LOGIN offered', async () => {
		const port = await start({ handshakeTimeout: 1 });
		const greeting = await tlsClient(port);
		expect(greeting).toContain('AUTH=PLAIN');
		expect(greeting).not.toContain('LOGINDISABLED');
		expect(server?.connections).toBe(1);
	});

	test('a garbage handshake is closed at once and counted out, and the server serves on', async () => {
		const port = await start({ maxConnections: 1 });
		const bad = await raw(port, 'a1 CAPABILITY\r\n');
		expect(await closedWithin(bad, 2000)).toBe(true);
		expect(await counted(0)).toBe(0);
		expect(await tlsClient(port)).toContain('IMAP4rev2 ready');
	});

	test('stop(true) with handshakes pending resets them: nothing written, nothing thrown', async () => {
		const errors: unknown[] = [];
		const port = await start({
			onError: (error) => {
				errors.push(error);
			},
		});
		const pending = [await raw(port), await raw(port), await raw(port)];
		expect(await counted(3)).toBe(3);
		expect(() => server?.stop(true)).not.toThrow();
		expect(await counted(0, 1)).toBe(0);
		for (const socket of pending) {
			expect(await closedWithin(socket, 1000)).toBe(true);
			expect(socket.received()).toBe(0);
		}
		expect(errors).toEqual([]);
	});

	test('loginTimeout counts from the greeting, not from the TCP connection', async () => {
		const port = await start({ loginTimeout: 1, handshakeTimeout: 10 });
		// TCP first, then a wait longer than loginTimeout before the ClientHello.
		const tcp = netConnect({ host: '127.0.0.1', port });
		await new Promise<void>((resolve) => tcp.once('connect', () => resolve()));
		await Bun.sleep(1500);
		const tls = tlsConnect({
			socket: tcp,
			servername: 'localhost',
			rejectUnauthorized: false,
		});
		nodeSockets.push(tls);
		let text = '';
		let greetedAt = 0;
		let byeAt = 0;
		tls.on('data', (chunk: Buffer) => {
			text += chunk.toString();
			if (!greetedAt && text.includes('IMAP4rev2 ready'))
				greetedAt = Date.now();
			if (!byeAt && text.includes('* BYE Too slow to log in'))
				byeAt = Date.now();
		});
		const end = Date.now() + 4000;
		while (!byeAt && Date.now() < end) await Bun.sleep(20);
		// Greeted, though the TCP connection is older than loginTimeout…
		expect(greetedAt).toBeGreaterThan(0);
		// …and cut loginTimeout after that greeting.
		expect(byeAt - greetedAt).toBeGreaterThanOrEqual(950);
		expect(byeAt - greetedAt).toBeLessThan(1500);
	});
});

describe('the socket handlers', () => {
	test('an error, a timeout, data or a drain on a socket open never set up throws nothing', () => {
		const shared = handlers(
			settingsOf(imapOptions(new MemoryMailStore(), 'account')),
		);
		const socket = {
			data: undefined,
			timeout() {},
			terminate() {},
		} as unknown as Socket<never>;
		expect(() =>
			shared.error?.(socket as never, new Error('handshake')),
		).not.toThrow();
		expect(() => shared.timeout?.(socket as never)).not.toThrow();
		expect(() =>
			shared.data?.(socket as never, Buffer.from('x')),
		).not.toThrow();
		expect(() => shared.drain?.(socket as never)).not.toThrow();
	});
});
