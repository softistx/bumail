import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket as NetSocket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { localhostTls } from './client.fixtures';
import { front } from './front.fixtures';
import type { ImapServerOptions } from './options';
import { v2 } from './proxy/headers.fixtures';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';

let server: ImapServer | undefined;
const sockets: NetSocket[] = [];
const fronts: { close(): void }[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const proxy of fronts.splice(0)) proxy.close();
	server?.stop(true);
	server = undefined;
});

/** Implicit TLS behind a trusted proxy; a `node:tls` client, through it. */
async function start(overrides: Partial<ImapServerOptions>) {
	const { store, accountId } = await seededStore();
	server = createImapServer(
		imapOptions(store, accountId, {
			tls: await localhostTls(),
			implicitTls: true,
			proxyProtocol: { trusted: ['127.0.0.1'] },
			...overrides,
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const proxy = await front(port, v2({ source: '198.51.100.7' }), {
		coalesce: true,
	});
	fronts.push(proxy);
	return new Promise<TLSSocket>((done, fail) => {
		const encrypted = tlsConnect(
			{
				port: proxy.port,
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

/** Resolves with the next line on `socket`. */
function line(socket: NetSocket): Promise<string> {
	return new Promise((done) => {
		let text = '';
		const read = (chunk: Buffer) => {
			text += chunk.toString('latin1');
			if (text.includes('\r\n')) {
				socket.off('data', read);
				done(text);
			}
		};
		socket.on('data', read);
	});
}

async function within(ms: number, check: () => boolean): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await Bun.sleep(20);
	}
	return true;
}

/** What `socket` reads from now on, and whether it ended cleanly. */
function reading(socket: NetSocket) {
	const seen = { text: '', ended: false };
	socket.on('data', (chunk: Buffer) => {
		seen.text += chunk.toString('latin1');
	});
	socket.on('end', () => {
		seen.ended = true;
	});
	socket.resume();
	return seen;
}

// As quiet.spec.ts of smtp, over ProxiedTls: a client that stops reading
// never holds a slot past the server's own decision to hang up on it.
describe('a client that stops reading, through implicit TLS behind a proxy', () => {
	test('is freed at loginTimeout, then reads the BYE and a clean end', async () => {
		const socket = await start({ loginTimeout: 1 });
		await line(socket);
		socket.pause();
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		const began = Date.now();
		expect(await within(3000, () => server?.connections === 0)).toBe(true);
		expect(Date.now() - began).toBeLessThan(2000);
		const seen = reading(socket);
		expect(await within(2000, () => seen.ended)).toBe(true);
		expect(seen.text).toBe('* BYE Too slow to log in, closing\r\n');
	}, 15_000);

	test('LOGOUT, then no more reading: freed at once, the OK read later', async () => {
		const socket = await start({});
		await line(socket);
		socket.write('a LOGOUT\r\n');
		socket.pause();
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
		const seen = reading(socket);
		expect(await within(2000, () => seen.ended)).toBe(true);
		expect(seen.text).toBe('* BYE Logging out\r\na OK LOGOUT completed\r\n');
	}, 15_000);
});
