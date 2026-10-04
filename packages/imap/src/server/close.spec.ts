import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	test,
} from 'bun:test';
import type { Socket as NetSocket } from 'node:net';
import { localhostTls, type PausedPath, pausedClient } from './client.fixtures';
import { Connection } from './connection';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';
import { LINGER_MAX_MS, LINGER_QUIET_MS, SocketTransport } from './transport';

const servers: ImapServer[] = [];
const clients: NetSocket[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.destroy();
	for (const server of servers.splice(0)) server.stop(true);
});

/**
 * A server whose `authenticate` never settles, within a `hookTimeout` far
 * past the `loginTimeout` of 1 s: a LOGIN holds the session's turn, so
 * nothing the client sends after it is read, and past `INPUT_LIMIT` the
 * server stops reading the socket — with nothing of its own queued.
 */
async function start(implicitTls: boolean) {
	const { store, accountId } = await seededStore();
	logins.count = 0;
	const server = createImapServer(
		imapOptions(store, accountId, {
			tls: await localhostTls(),
			implicitTls,
			loginTimeout: 1,
			hookTimeout: 600,
			authenticate: () => {
				logins.count++;
				return new Promise<null>(() => {});
			},
		}),
	);
	servers.push(server);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { server, port };
}

/** How many LOGINs reached `authenticate`. */
const logins = { count: 0 };

/** Polls `check` every 20 ms for `ms` at most. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await Bun.sleep(20);
	}
	return true;
}

/**
 * How often the server stopped reading, when it decided to hang up (a
 * forced close), and when its socket closed.
 */
const events = {
	pauses: 0,
	decided: [] as number[],
	closes: [] as number[],
};
const { close } = Connection.prototype;
const { pause, closed: transportClosed } = SocketTransport.prototype;
/** Transports already closed: `stop(true)` calls `closed()` a second time. */
const seenClosed = new WeakSet<SocketTransport>();
beforeAll(() => {
	SocketTransport.prototype.closed = function () {
		if (!seenClosed.has(this)) {
			seenClosed.add(this);
			events.closes.push(performance.now());
		}
		transportClosed.call(this);
	};
	Connection.prototype.close = function (bye, options) {
		if (!this.closed && options?.forced) events.decided.push(performance.now());
		return close.call(this, bye, options);
	};
	SocketTransport.prototype.pause = function () {
		events.pauses++;
		pause.call(this);
	};
});
afterAll(() => {
	Connection.prototype.close = close;
	SocketTransport.prototype.pause = pause;
	SocketTransport.prototype.closed = transportClosed;
});

/** Four times `INPUT_LIMIT` (256 KiB), behind a LOGIN that never answers. */
const PAST_THE_LIMIT = `a LOGIN alice secret\r\n${'x'.repeat(1024 * 1024)}`;

/** A client of `path` that sends `PAST_THE_LIMIT` and never reads. */
async function neverReads(port: number, path: PausedPath) {
	const client = await pausedClient(port, path);
	clients.push(client);
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
	client.write(PAST_THE_LIMIT);
	return { client, seen, text: () => text };
}

/**
 * How long after its decision the server's socket may close, past
 * `LINGER_MAX_MS`, as its `close` handler reports. Measured 30 runs each
 * on macOS and on Linux (`oven/bun:1.4.2`), three copies at once beside 12
 * busy cores: a hang-up lingering over a client gone quiet closed 20.5 to
 * 35.0 ms after it; over a client still sending, 22.0 to 527.8 ms after,
 * so 28 ms past `LINGER_MAX_MS` at most. Under load such a client can
 * pause for 20 ms, and the linger half-closes then, before
 * `LINGER_MAX_MS`: only the quiet time bounds it from below.
 */
const LATE_MS = 250;

/**
 * It lingered — never a half-close at once over unread input — then
 * half-closed once the client went quiet, before it would have reset.
 * A millisecond off the quiet time, for the timer's rounding.
 */
function closedWhenQuiet(ms: number): void {
	expect(ms).toBeGreaterThanOrEqual(LINGER_QUIET_MS - 1);
	expect(ms).toBeLessThan(LINGER_MAX_MS);
}

/** It lingered, and closed by `LINGER_MAX_MS`: quiet, or reset there. */
function closedByMax(ms: number): void {
	expect(ms).toBeGreaterThanOrEqual(LINGER_QUIET_MS - 1);
	expect(ms).toBeLessThan(LINGER_MAX_MS + LATE_MS);
}

/**
 * The server stopped reading, decided to hang up at `loginTimeout`, and
 * the slot was free within 1 s of that decision, not at the grace. Gives
 * how long after the decision its socket closed.
 */
async function freedAtOnce(server: ImapServer): Promise<number> {
	expect(await within(500, () => events.pauses > 0)).toBe(true);
	expect(server.connections).toBe(1);
	expect(await within(3_000, () => events.decided.length > 0)).toBe(true);
	const decided = events.decided[0] as number;
	expect(await within(1_000, () => server.connections === 0)).toBe(true);
	expect(performance.now() - decided).toBeLessThan(1_000);
	return (events.closes[0] as number) - decided;
}

describe('a client that sends past INPUT_LIMIT and never reads', () => {
	afterEach(() => {
		events.pauses = 0;
		events.decided = [];
		events.closes = [];
	});

	for (const path of ['implicit TLS', 'STARTTLS'] as const) {
		test(`(${path}) is cut at loginTimeout with its slot freed at once, and reads the BYE, then the end`, async () => {
			const { server, port } = await start(path === 'implicit TLS');
			const { client, seen, text } = await neverReads(port, path);
			closedWhenQuiet(await freedAtOnce(server));
			client.resume();
			expect(
				await within(2_000, () => seen.ended || seen.failed !== undefined),
			).toBe(true);
			expect(seen.failed).toBeUndefined();
			expect(text()).toEndWith('* BYE Too slow to log in, closing\r\n');
		}, 10_000);

		test(`(${path}) and keeps sending is cut at loginTimeout with its slot freed at once, and nothing it sent after runs`, async () => {
			const { server, port } = await start(path === 'implicit TLS');
			const { client } = await neverReads(port, path);
			// Commands, each a LOGIN: once the server hangs up, none may run.
			const chunk = `\r\n${'b LOGIN alice secret\r\n'.repeat(3_000)}`;
			const flood = setInterval(() => client.write(chunk), 20);
			try {
				// A chunk every 20 ms: quiet, or reset at LINGER_MAX_MS.
				closedByMax(await freedAtOnce(server));
				await Bun.sleep(200);
			} finally {
				clearInterval(flood);
			}
			expect(logins.count).toBe(1);
		}, 10_000);

		test(`(${path}) and reads but never stops sending is cut at loginTimeout with its slot freed at once, after the BYE`, async () => {
			const { server, port } = await start(path === 'implicit TLS');
			const { client, text } = await neverReads(port, path);
			client.resume();
			// Sends without a pause: refills whenever its buffer drains.
			const chunk = 'x'.repeat(64 * 1024);
			let sending = true;
			const send = () => {
				while (sending && !client.destroyed && client.write(chunk));
			};
			client.on('drain', send);
			send();
			try {
				closedByMax(await freedAtOnce(server));
				expect(
					await within(1_000, () => text().includes('* BYE Too slow')),
				).toBe(true);
			} finally {
				sending = false;
			}
			expect(text()).toEndWith('* BYE Too slow to log in, closing\r\n');
		}, 10_000);
	}
});
