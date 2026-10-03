import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { connect } from 'node:net';
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

/**
 * A server that falls behind: it stops reading at the first bytes, then
 * decides to hang up with nothing of its own queued. Over the input it
 * never read, a half-close does not fire `close`, and the slot waited for
 * the grace; the transport reads again first, so it closes at once.
 */
async function pausedServer(
	run: (
		port: number,
		closed: () => boolean,
		times: { decided: number; closed: number },
	) => Promise<void>,
): Promise<void> {
	let transport: SocketTransport | undefined;
	let closed = false;
	let paused = false;
	const times = { decided: 0, closed: 0 };
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
				transport?.received();
				if (!transport || paused) return;
				paused = true;
				transport.pause();
				setTimeout(() => {
					times.decided = performance.now();
					transport?.write('421 closing\r\n');
					transport?.abort();
				}, 100);
			},
			drain() {
				transport?.drain();
			},
			close() {
				times.closed = performance.now();
				closed = true;
				transport?.closed();
			},
		},
	});
	try {
		await run(listener.port, () => closed, times);
	} finally {
		listener.stop(true);
	}
}

describe('a hang-up while the server paused reading', () => {
	test('completes at once for a client that keeps sending and never reads', async () => {
		await pausedServer(async (port, closed) => {
			const client = await Client.connect(port);
			await client.reply();
			client.pause();
			client.write(EHLOS);
			expect(await within(1_000, closed)).toBe(true);
			expect(await hungUp(client)).toBe(true);
		});
	});

	test('completes at once, and a client that stopped sending reads the 421, then the end', async () => {
		await pausedServer(async (port, closed) => {
			// node:net, whose pause leaves what the server sends in the kernel.
			const client = connect({ host: '127.0.0.1', port });
			try {
				let text = '';
				const seen = { ended: false, failed: undefined as unknown };
				client.on('data', (chunk: Buffer) => {
					text += chunk.toString('latin1');
				});
				client.on('end', () => {
					seen.ended = true;
				});
				client.on('error', (error) => {
					seen.failed = error;
				});
				await within(1_000, () => text.includes('220 ready'));
				client.pause();
				client.write('NOOP\r\n'.repeat(175_000));
				expect(await within(1_000, closed)).toBe(true);
				client.resume();
				expect(
					await within(2_000, () => seen.ended || seen.failed !== undefined),
				).toBe(true);
				expect(seen.failed).toBeUndefined();
				expect(text).toEndWith('421 closing\r\n');
			} finally {
				client.destroy();
			}
		});
	});

	test('is bounded for a client that reads and never stops sending: the 421 arrives, then the reset', async () => {
		await pausedServer(async (port, closed, times) => {
			const client = connect({ host: '127.0.0.1', port });
			let sending = true;
			try {
				let text = '';
				client.on('data', (chunk: Buffer) => {
					text += chunk.toString('latin1');
				});
				client.on('error', () => {});
				await within(1_000, () => text.includes('220 ready'));
				// Sends without a pause: refills whenever its buffer drains.
				const chunk = 'NOOP\r\n'.repeat(10_000);
				const send = () => {
					while (sending && !client.destroyed && client.write(chunk));
				};
				client.on('drain', send);
				send();
				expect(await within(2_000, closed)).toBe(true);
				expect(times.closed - times.decided).toBeLessThan(1_000);
				expect(await within(1_000, () => text.includes('421 closing'))).toBe(
					true,
				);
				expect(text).toEndWith('421 closing\r\n');
			} finally {
				sending = false;
				client.destroy();
			}
		});
	});
});

describe('a hang-up the server decides while it paused reading', () => {
	test('nothing the client sends after it runs, however much it keeps sending, and the slot is freed at once', async () => {
		let rcpts = 0;
		const port = await start({
			maxErrors: 5,
			// Each RCPT takes 20 ms: what is pipelined behind it piles up past
			// the input limit, and the server stops reading.
			onRcptTo: async () => {
				rcpts++;
				await Bun.sleep(20);
			},
		});
		// A RCPT, then a command that fails: the fifth failure hangs up
		// (maxErrors), behind the fifth RCPT.
		const pair = 'RCPT TO:<a@foo.com>\r\nBOGUS\r\n';
		const client = connect({ host: '127.0.0.1', port });
		client.on('error', () => {});
		const flood = setInterval(() => client.write(pair.repeat(2_000)), 20);
		const { pause } = SocketTransport.prototype;
		let pauses = 0;
		SocketTransport.prototype.pause = function () {
			pauses++;
			pause.call(this);
		};
		try {
			client.write(`EHLO a\r\nMAIL FROM:<a@b.com>\r\n${pair.repeat(10_000)}`);
			expect(await within(2_000, () => rcpts >= 5)).toBe(true);
			expect(pauses).toBeGreaterThan(0);
			const decided = performance.now();
			expect(await within(1_000, () => server?.connections === 0)).toBe(true);
			expect(performance.now() - decided).toBeLessThan(1_000);
			await Bun.sleep(200);
			// Nothing pipelined behind the hang-up ran.
			expect(rcpts).toBe(5);
		} finally {
			SocketTransport.prototype.pause = pause;
			clearInterval(flood);
			client.destroy();
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
