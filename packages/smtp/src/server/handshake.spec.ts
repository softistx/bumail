import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import { Client } from './client.fixtures';
import type { SmtpServerOptions } from './options';
import { createSmtpServer, handlers, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';
import { settingsOf } from './settings';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
const sockets: Socket<undefined>[] = [];
const clients: Client[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.terminate();
	for (const client of clients.splice(0)) client.end();
	server?.stop(true);
	server = undefined;
});

async function start(overrides: Partial<SmtpServerOptions> = {}) {
	server = createSmtpServer(
		mxOptions({ tls, implicitTls: true, ...overrides }),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return port;
}

/** A plain TCP socket to the implicit TLS port that never sends a ClientHello, or sends `garbage`. */
async function raw(
	port: number,
	garbage?: string,
): Promise<{
	socket: Socket<undefined>;
	closed: () => boolean;
	received: () => number;
}> {
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
	return { socket, closed: () => closed, received: () => received };
}

async function tlsClient(port: number): Promise<string> {
	const client = await Client.connect(port, true);
	clients.push(client);
	return client.reply();
}

async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

describe('implicit TLS before the handshake', () => {
	test('a socket that never sends a ClientHello holds a slot of maxConnections', async () => {
		const port = await start({ maxConnections: 2 });
		await raw(port);
		await raw(port);
		expect(await counted(2)).toBe(2);
		// The refusal waits for the handshake, so a TLS client reads it.
		expect(await tlsClient(port)).toBe(
			'421 4.3.2 foo.com Too many connections, try later\r\n',
		);
	});

	test('and one of maxConnectionsPerClient', async () => {
		const port = await start({ maxConnectionsPerClient: 2 });
		await raw(port);
		await raw(port);
		expect(await counted(2)).toBe(2);
		expect(await tlsClient(port)).toBe(
			'421 4.7.0 foo.com Too many connections from your address, try later\r\n',
		);
	});

	test('handshakeTimeout closes it and frees its slot, whatever the idle timeout', async () => {
		const port = await start({
			maxConnectionsPerClient: 1,
			handshakeTimeout: 1,
			timeout: 600,
		});
		const silent = await raw(port);
		expect(await counted(1)).toBe(1);
		// Bun's socket timer ticks in steps of about 4 s.
		expect(await counted(0, 7)).toBe(0);
		for (let i = 0; i < 50 && !silent.closed(); i++) await Bun.sleep(20);
		expect(silent.closed()).toBe(true);
		expect(await tlsClient(port)).toStartWith('220');
	}, 12_000);

	test('a client that completes the handshake is greeted, and onConnect runs after it', async () => {
		const secure: boolean[] = [];
		const port = await start({
			handshakeTimeout: 1,
			onConnect: (session) => {
				secure.push(session.secure);
			},
		});
		expect(await tlsClient(port)).toBe('220 foo.com ESMTP ready\r\n');
		expect(secure).toEqual([true]);
	});

	test('a failed handshake (no TLS at all) is counted out, and the server goes on', async () => {
		const port = await start({ maxConnectionsPerClient: 1 });
		const bad = await raw(port, 'EHLO bar.com\r\n');
		for (let i = 0; i < 100 && !bad.closed(); i++) await Bun.sleep(20);
		expect(bad.closed()).toBe(true);
		expect(await counted(0)).toBe(0);
		expect(await tlsClient(port)).toStartWith('220');
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
			for (let i = 0; i < 50 && !socket.closed(); i++) await Bun.sleep(20);
			expect(socket.closed()).toBe(true);
			expect(socket.received()).toBe(0);
		}
		expect(errors).toEqual([]);
	});
});

describe('the socket handlers', () => {
	test('an error, a timeout, data or a drain on a socket open never set up throws nothing', () => {
		const shared = handlers(settingsOf(mxOptions()));
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
