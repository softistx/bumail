import { afterEach, describe, expect, test } from 'bun:test';
import { connect as connectTcp, type Socket } from 'node:net';
import { connect as connectTls, type TLSSocket } from 'node:tls';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';
import { CLOSE_GRACE_MS } from './transport';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
const sockets: Socket[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	server?.stop(true);
	server = undefined;
});

async function start(overrides = {}) {
	server = createSmtpServer(mxOptions({ timeout: 1, tls, ...overrides }));
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return port;
}

/** Polls `check` every 20 ms for `ms` at most. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await Bun.sleep(20);
	}
	return true;
}

/** Resolves with the next complete reply on `socket`. */
function reply(socket: Socket): Promise<string> {
	return new Promise((done) => {
		let text = '';
		const read = (chunk: Buffer) => {
			text += chunk.toString('latin1');
			if (/(^|\n)\d{3} [^\n]*\n$/.test(text)) {
				socket.off('data', read);
				done(text);
			}
		};
		socket.on('data', read);
	});
}

function plain(port: number): Promise<Socket> {
	return new Promise((done) => {
		const socket = connectTcp({ port, host: '127.0.0.1' }, () => done(socket));
		sockets.push(socket);
	});
}

function secure(port: number, socket?: Socket): Promise<TLSSocket> {
	return new Promise((done, fail) => {
		const encrypted = connectTls(
			socket
				? { socket, rejectUnauthorized: false, servername: 'localhost' }
				: {
						port,
						host: '127.0.0.1',
						rejectUnauthorized: false,
						servername: 'localhost',
					},
			() => done(encrypted),
		);
		encrypted.once('error', fail);
		sockets.push(encrypted);
	});
}

/**
 * The client greets as asked, then pauses and stays quiet: it never reads
 * again and never answers the server's hang-up, as a stalled peer would.
 */
async function quiet(socket: Socket, ehlo: boolean): Promise<void> {
	if (ehlo) {
		socket.write('EHLO bar.com\r\n');
		await reply(socket);
	}
	socket.pause();
}

/** Opens a session in clear and moves it to TLS with STARTTLS. */
async function startTls(port: number, ehlo: boolean): Promise<TLSSocket> {
	const clear = await plain(port);
	await reply(clear);
	clear.write('EHLO bar.com\r\n');
	await reply(clear);
	clear.write('STARTTLS\r\n');
	expect(await reply(clear)).toStartWith('220 ');
	const socket = await secure(port, clear);
	await quiet(socket, ehlo);
	return socket;
}

/**
 * Bun checks socket timeouts every 4 s or so: 1 s of idle time is up within
 * 6, then the close itself is bounded by the grace.
 */
const BOUND = 6000 + CLOSE_GRACE_MS;

/*
 * A client that pauses and stays quiet never answers the server's hang-up.
 * On TLS, Bun's socket.end() waits for that answer before `close` fires, so
 * the connection kept its slot of maxConnections for good; a plain socket
 * was freed at once. Every path is checked over a real socket.
 */
describe('a quiet client is counted out within a bound after the idle timeout', () => {
	test('plain', async () => {
		const port = await start();
		const socket = await plain(port);
		await reply(socket);
		await quiet(socket, true);
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		expect(await within(BOUND, () => server?.connections === 0)).toBe(true);
	}, 15_000);

	test('implicit TLS', async () => {
		const port = await start({ implicitTls: true });
		const socket = await secure(port);
		await reply(socket);
		await quiet(socket, true);
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		expect(await within(BOUND, () => server?.connections === 0)).toBe(true);
	}, 15_000);

	test('implicit TLS, quiet from the greeting on', async () => {
		const port = await start({ implicitTls: true });
		const socket = await secure(port);
		await reply(socket);
		await quiet(socket, false);
		expect(await within(BOUND, () => server?.connections === 0)).toBe(true);
	}, 15_000);

	test('after STARTTLS', async () => {
		const port = await start();
		await startTls(port, true);
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		expect(await within(BOUND, () => server?.connections === 0)).toBe(true);
	}, 15_000);

	test('after STARTTLS, quiet from the handshake on', async () => {
		const port = await start();
		await startTls(port, false);
		expect(await within(BOUND, () => server?.connections === 0)).toBe(true);
	}, 15_000);
});

/** A quiet client after EHLO, over each path. */
const paths: [string, (port: number) => Promise<Socket>, object][] = [
	[
		'plain',
		async (port) => {
			const socket = await plain(port);
			await reply(socket);
			await quiet(socket, true);
			return socket;
		},
		{},
	],
	[
		'implicit TLS',
		async (port) => {
			const socket = await secure(port);
			await reply(socket);
			await quiet(socket, true);
			return socket;
		},
		{ implicitTls: true },
	],
	['after STARTTLS', (port) => startTls(port, true), {}],
];

describe('the 421 still reaches a quiet client, then a clean end', () => {
	for (const [name, open, overrides] of paths) {
		test(`${name}: counted out before the grace, and the reply read once it reads again`, async () => {
			const port = await start(overrides);
			const socket = await open(port);
			// The idle timeout, not the grace: the hang-up itself closes at once.
			expect(await within(7000, () => server?.connections === 0)).toBe(true);
			let text = '';
			let ended = false;
			socket.on('data', (chunk: Buffer) => {
				text += chunk.toString('latin1');
			});
			socket.on('end', () => {
				ended = true;
			});
			socket.resume();
			expect(await within(2000, () => ended)).toBe(true);
			expect(text).toBe('421 4.4.2 foo.com Idle too long, closing\r\n');
		}, 15_000);
	}
});

describe('QUIT on TLS does not wait on the client either', () => {
	test('a client that sends QUIT and stops reading is counted out, and gets the 221 later', async () => {
		const port = await start({ implicitTls: true, timeout: 300 });
		const socket = await secure(port);
		await reply(socket);
		socket.write('QUIT\r\n');
		socket.pause();
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
		const closing = reply(socket);
		socket.resume();
		expect(await closing).toStartWith('221 ');
	}, 15_000);

	test('after STARTTLS, a client that reads gets the 221 and the end', async () => {
		const port = await start({ timeout: 300 });
		const socket = await startTls(port, true);
		socket.resume();
		const closing = reply(socket);
		socket.write('QUIT\r\n');
		expect(await closing).toStartWith('221 ');
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
	}, 15_000);
});
