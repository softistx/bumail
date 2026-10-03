import { afterEach, describe, expect, test } from 'bun:test';
import { ImapError } from '../errors';
import {
	Client,
	localhostTls,
	pausedTlsClient,
	slowTlsReader,
} from './client.fixtures';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';
import { CLOSE_GRACE } from './transport';

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

/** Polls `check` every 20 ms for `ms` at most. */
async function within(ms: number, check: () => boolean): Promise<boolean> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) return false;
		await Bun.sleep(20);
	}
	return true;
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

	test('maxConnections on implicit TLS: one too many gets BYE, then the socket closes', async () => {
		const { server, port } = await start({
			implicitTls: true,
			maxConnections: 1,
		});
		const first = await Client.connect(port, true);
		expect(await first.line()).toContain('IMAP4rev2 ready');
		const second = await Client.connect(port, true);
		expect(await second.line()).toBe(
			'* BYE [UNAVAILABLE] Too many connections, try later\r\n',
		);
		expect(await second.until(() => second.closed)).toBe(true);
		expect(server.connections).toBe(1);
		first.end();
	});

	test('a slow reader of a large FETCH pipelined with LOGOUT gets every byte, then BYE, then the close', async () => {
		const { port, store, accountId, inbox } = await start({
			implicitTls: true,
		});
		const line = `${'y'.repeat(998)}\r\n`;
		const content = `Subject: large\r\n\r\n${line.repeat(4096)}`;
		await store.addMessage(accountId, inbox.id, {
			content: new TextEncoder().encode(content),
		});
		const client = slowTlsReader(port);
		await client.waitFor('ready\r\n');
		const plain = new TextEncoder().encode('\0alice\0secret').toBase64();
		client.socket.write(`a AUTHENTICATE PLAIN ${plain}\r\nb SELECT INBOX\r\n`);
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
		expect(text.indexOf('* BYE Logging out\r\n')).toBeGreaterThan(body);
		expect(text).toEndWith('* BYE Logging out\r\nd OK LOGOUT completed\r\n');
		// Shut down once the queue left, not terminated at the grace.
		expect(Date.now() - (client.lastDataAt ?? 0)).toBeLessThan(CLOSE_GRACE);
	}, 15_000);

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

	test('a client that never reads is still cut at loginTimeout, and its slot freed', async () => {
		const { server, port } = await start({ loginTimeout: 1 });
		const client = await Client.connect(port);
		await client.line();
		client.pause();
		client.write('a CAPABILITY\r\n'.repeat(60_000));
		expect(await within(500, () => server.connections === 1)).toBe(true);
		expect(await within(3000, () => server.connections === 0)).toBe(true);
		expect(await within(1000, () => client.closed)).toBe(true);
	}, 10_000);

	// On TLS, Bun's `end()` waits for the client's own close before `close`
	// fires: a client that stopped reading never sends it, so only the
	// grace timer's `terminate` frees the slot. Nothing is queued here.
	for (const starttls of [false, true]) {
		const how = starttls ? 'after STARTTLS' : 'on implicit TLS';
		test(`a paused client ${how} is cut at loginTimeout, and its slot freed`, async () => {
			const { server, port } = await start({
				implicitTls: !starttls,
				loginTimeout: 1,
			});
			const client = await pausedTlsClient(port, starttls);
			try {
				expect(await within(500, () => server.connections === 1)).toBe(true);
				expect(
					await within(
						1000 + CLOSE_GRACE + 2000,
						() => server.connections === 0,
					),
				).toBe(true);
			} finally {
				client.destroy();
			}
		}, 15_000);
	}

	test('a clear client on the implicit-TLS port is dropped, and the server serves on', async () => {
		const { server, port } = await start({ implicitTls: true });
		const clear = await Client.connect(port);
		clear.write('a1 CAPABILITY\r\n');
		expect(await clear.until(() => clear.closed)).toBe(true);
		expect(server.connections).toBe(0);
		const client = await Client.connect(port, true);
		expect(await client.line()).toContain('IMAP4rev2 ready');
		client.end();
	});

	test('listen twice throws ALREADY_LISTENING', async () => {
		const { server } = await start();
		expect(server.listen({ port: 0 })).rejects.toThrow(ImapError);
	});
});
