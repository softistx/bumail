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
import { SocketTransport } from './transport';

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
	const server = createImapServer(
		imapOptions(store, accountId, {
			tls: await localhostTls(),
			implicitTls,
			loginTimeout: 1,
			hookTimeout: 600,
			authenticate: () => new Promise<null>(() => {}),
		}),
	);
	servers.push(server);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { server, port };
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

/** How often the server stopped reading, and when it decided to hang up: a forced close. */
const events = { pauses: 0, decided: [] as number[] };
const { close } = Connection.prototype;
const { pause } = SocketTransport.prototype;
beforeAll(() => {
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
 * The server stopped reading, decided to hang up at `loginTimeout`, and
 * the slot was free within 1 s of that decision, not at the grace.
 */
async function freedAtOnce(server: ImapServer): Promise<void> {
	expect(await within(500, () => events.pauses > 0)).toBe(true);
	expect(server.connections).toBe(1);
	expect(await within(3_000, () => events.decided.length > 0)).toBe(true);
	const decided = events.decided[0] as number;
	expect(await within(1_000, () => server.connections === 0)).toBe(true);
	expect(performance.now() - decided).toBeLessThan(1_000);
}

describe('a client that sends past INPUT_LIMIT and never reads', () => {
	afterEach(() => {
		events.pauses = 0;
		events.decided = [];
	});

	for (const path of ['implicit TLS', 'STARTTLS'] as const) {
		test(`(${path}) is cut at loginTimeout with its slot freed at once, and reads the BYE, then the end`, async () => {
			const { server, port } = await start(path === 'implicit TLS');
			const { client, seen, text } = await neverReads(port, path);
			await freedAtOnce(server);
			client.resume();
			expect(
				await within(2_000, () => seen.ended || seen.failed !== undefined),
			).toBe(true);
			expect(seen.failed).toBeUndefined();
			expect(text()).toEndWith('* BYE Too slow to log in, closing\r\n');
		}, 10_000);

		test(`(${path}) and keeps sending is cut at loginTimeout with its slot freed at once`, async () => {
			const { server, port } = await start(path === 'implicit TLS');
			const { client } = await neverReads(port, path);
			const chunk = 'x'.repeat(64 * 1024);
			const flood = setInterval(() => client.write(chunk), 20);
			try {
				await freedAtOnce(server);
			} finally {
				clearInterval(flood);
			}
		}, 10_000);
	}
});
