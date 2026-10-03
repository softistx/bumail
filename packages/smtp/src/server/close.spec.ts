import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import type { Socket } from 'bun';
import { Client } from './client.fixtures';
import { Connection } from './connection';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';
import { CLOSE_GRACE_MS, SocketTransport } from './transport';

let server: SmtpServer | undefined;
afterEach(() => {
	server?.stop(true);
	server = undefined;
});

async function start(overrides = {}) {
	server = createSmtpServer(mxOptions(overrides));
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

/** An EHLO's reply is many times the command: the replies fill every buffer long before the commands do. */
const EHLOS = 'EHLO a\r\n'.repeat(200_000);

/**
 * A client that pipelines commands and never reads a reply: the server's
 * replies fill the kernel's buffers, then its own queue. A close the server
 * decides on must still complete, or the connection keeps a slot of
 * `maxConnections` for good.
 */
async function neverReads(port: number, text: string): Promise<Client> {
	const client = await Client.connect(port);
	await client.reply();
	client.pause();
	client.write(text);
	return client;
}

/**
 * The socket is closed: once the client reads again, it sees the hang-up
 * (a reset, or the end after what the kernel still held for it).
 */
async function hungUp(client: Client): Promise<boolean> {
	client.resume();
	return within(2000, () => client.closed);
}

/**
 * When the server last read a byte and when it decided to hang up — the
 * moments the bounds below count from. Bun sweeps socket timeouts every
 * 4 seconds, so when an idle time of 1 s is up depends on where the sweeps
 * fall, which no spec controls; what the server does once it is up does
 * not.
 */
const events = { lastByte: 0, hangUps: [] as number[] };
const { receive } = Connection.prototype;
const { abort } = SocketTransport.prototype;
beforeAll(() => {
	Connection.prototype.receive = function (chunk) {
		events.lastByte = performance.now();
		receive.call(this, chunk);
	};
	SocketTransport.prototype.abort = function () {
		events.hangUps.push(performance.now());
		abort.call(this);
	};
});
afterAll(() => {
	Connection.prototype.receive = receive;
	SocketTransport.prototype.abort = abort;
});

/**
 * The idle time is up for `clients` connections, and each is counted out at
 * once, not after `CLOSE_GRACE_MS`: their slots are free.
 */
async function countedOut(clients: number): Promise<void> {
	// Two sweeps after the last byte read at most, and a margin for CI.
	expect(await within(10_000, () => events.hangUps.length >= clients)).toBe(
		true,
	);
	const decided = events.hangUps[clients - 1] as number;
	expect(decided - events.lastByte).toBeLessThan(8_000 + 1_000);
	expect(await within(1_000, () => server?.connections === 0)).toBe(true);
	expect(performance.now() - decided).toBeLessThan(CLOSE_GRACE_MS);
}

describe('a client that never reads is still disconnected', () => {
	beforeEach(() => {
		events.lastByte = 0;
		events.hangUps = [];
	});

	test('idle timeout: the connection is counted out at once, and the socket closed', async () => {
		const port = await start({ timeout: 1 });
		const client = await neverReads(port, EHLOS);
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		await countedOut(1);
		expect(await hungUp(client)).toBe(true);
	}, 20_000);

	test('such clients do not lock others out of maxConnections', async () => {
		const port = await start({ timeout: 1, maxConnections: 2 });
		const hostile = [
			await neverReads(port, EHLOS),
			await neverReads(port, EHLOS),
		];
		expect(await within(500, () => server?.connections === 2)).toBe(true);
		await countedOut(2);
		const next = await Client.connect(port);
		expect(await next.reply()).toBe('220 foo.com ESMTP ready\r\n');
		next.end();
		for (const client of hostile) expect(await hungUp(client)).toBe(true);
	}, 20_000);

	test('QUIT behind replies the client never reads does not keep the slot either', async () => {
		const port = await start({ timeout: 1 });
		const client = await neverReads(port, `${EHLOS}QUIT\r\n`);
		await countedOut(1);
		expect(await hungUp(client)).toBe(true);
	}, 20_000);
});

describe('a hang-up while the server paused reading', () => {
	test('is a reset, at once: a half-close would wait on the unread input until the grace', async () => {
		let transport: SocketTransport | undefined;
		let closed = false;
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				open(socket) {
					transport = new SocketTransport(
						socket as Socket<unknown>,
						false,
						() => {},
					);
					transport.write('220 ready\r\n');
				},
				data() {
					// The server falls behind: it stops reading, then decides to
					// hang up with nothing of its own queued.
					transport?.pause();
					transport?.write('421 closing\r\n');
					transport?.abort();
				},
				drain() {
					transport?.drain();
				},
				close() {
					closed = true;
					transport?.closed();
				},
			},
		});
		try {
			const client = await Client.connect(listener.port);
			await client.reply();
			client.pause();
			client.write(EHLOS);
			expect(await within(1_000, () => closed)).toBe(true);
			expect(await hungUp(client)).toBe(true);
		} finally {
			listener.stop(true);
		}
	});
});

describe('QUIT still closes gracefully', () => {
	test('221, then the socket closes and the connection is counted out', async () => {
		const port = await start();
		const client = await Client.connect(port);
		await client.reply();
		expect(await client.command('QUIT')).toStartWith('221 foo.com closing');
		expect(await within(1000, () => client.closed)).toBe(true);
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
	});

	test('QUIT pipelined behind many commands: every reply, then the 221, arrives', async () => {
		const port = await start();
		const client = await Client.connect(port);
		await client.reply();
		const count = 50_000;
		client.pause();
		client.write(`${'NOOP\r\n'.repeat(count)}QUIT\r\n`);
		await Bun.sleep(300);
		client.resume();
		expect(
			await client.until((text) => text.includes('221 foo.com closing'), 10),
		).toBe(true);
		expect(client.received.split('250 OK\r\n').length - 1).toBe(count);
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
	}, 15_000);
});
