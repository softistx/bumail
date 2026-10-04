import { afterEach, describe, expect, test } from 'bun:test';
import { Client, localhostTls } from './client.fixtures';
import type { ImapServerOptions } from './options';
import { concat, v1, v2 } from './proxy/headers.fixtures';
import { createImapServer, type ImapServer } from './server';
import { imapOptions, seededStore } from './session.fixtures';

let server: ImapServer | undefined;
const clients: Client[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.end();
	server?.stop(true);
	server = undefined;
});

/** A server trusting the specs' own address as its proxy, and who `authenticate` saw. */
async function start(overrides: Partial<ImapServerOptions> = {}) {
	const { store, accountId } = await seededStore();
	const seen: string[] = [];
	const errors: unknown[] = [];
	server = createImapServer(
		imapOptions(store, accountId, {
			tls: await localhostTls(),
			proxyProtocol: { trusted: ['127.0.0.1', '::1'] },
			authenticate: (_, session) => {
				seen.push(session.remoteAddress);
				return accountId;
			},
			onError: (error) => {
				errors.push(error);
			},
			...overrides,
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	return { port, seen, errors };
}

async function connect(port: number, first?: Uint8Array | string) {
	const client = await Client.connect(port);
	clients.push(client);
	if (first !== undefined) client.write(first);
	return client;
}

/** STARTTLS, then LOGIN: `authenticate` sees the session's address. */
async function logIn(client: Client): Promise<string> {
	await client.command('a', 'STARTTLS');
	await client.startTls();
	return client.command('b', 'LOGIN alice secret');
}

async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

describe('a trusted proxy', () => {
	test('v1, v2 over IPv4 and IPv6: the client is the source, through STARTTLS', async () => {
		const { port, seen } = await start();
		for (const header of [
			v1('198.51.100.7'),
			v2({ source: '203.0.113.5' }),
			v2({ source: '2001:db8::7' }),
		]) {
			const client = await connect(port, header);
			expect(await client.line()).toContain('IMAP4rev2 ready');
			expect(await logIn(client)).toStartWith('b OK');
		}
		expect(seen).toEqual(['198.51.100.7', '203.0.113.5', '2001:db8::7']);
	});

	test('v2 LOCAL, UNSPEC and v1 UNKNOWN keep the peer', async () => {
		const { port, seen } = await start();
		for (const header of [
			v2({ command: 0, family: 0 }),
			v2({ family: 0 }),
			new TextEncoder().encode('PROXY UNKNOWN\r\n'),
		]) {
			const client = await connect(port, header);
			await client.line();
			await logIn(client);
		}
		expect(seen).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1']);
	});

	test('what the client sent behind the header is answered after the greeting', async () => {
		const { port } = await start();
		const client = await connect(
			port,
			concat(v1('198.51.100.7'), 'a NOOP\r\n'),
		);
		expect(await client.line()).toContain('IMAP4rev2 ready');
		expect(await client.answer('a')).toStartWith('a OK');
	});

	test('a socket awaiting its header holds no slot of maxConnections', async () => {
		const { port } = await start({ maxConnections: 1 });
		await connect(port);
		await Bun.sleep(100);
		expect(server?.connections).toBe(0);
		const client = await connect(port, v1('198.51.100.9'));
		expect(await client.line()).toContain('IMAP4rev2 ready');
		expect(await counted(1)).toBe(1);
	});
});

describe('a trusted proxy that sends no valid header is closed, without a word', () => {
	async function refused(first: Uint8Array | string) {
		const { port, seen, errors } = await start({ handshakeTimeout: 1 });
		const client = await connect(port, first);
		const began = Date.now();
		await client.until(() => false, 2);
		expect(client.closed).toBe(true);
		expect(client.received).toBe('');
		expect(seen).toEqual([]);
		expect(errors).toEqual([]);
		expect(server?.connections).toBe(0);
		return Date.now() - began;
	}

	test('garbage: an IMAP command first', async () => {
		expect(await refused('a CAPABILITY\r\n')).toBeLessThan(500);
	});

	test('a v1 line past 107 bytes', async () => {
		expect(await refused(`PROXY UNKNOWN ${'x'.repeat(120)}`)).toBeLessThan(500);
	});

	test('v2 announcing more TLVs than allowed', async () => {
		const header = v2({ source: '198.51.100.7', length: 65_535 });
		expect(await refused(header.subarray(0, 16))).toBeLessThan(500);
	});

	test('a truncated header, at handshakeTimeout', async () => {
		const elapsed = await refused(v1('198.51.100.7').subarray(0, 20));
		expect(elapsed).toBeGreaterThanOrEqual(900);
	});

	test('a slowloris, a byte at a time, at handshakeTimeout however it trickles', async () => {
		const { port } = await start({ handshakeTimeout: 1 });
		const client = await connect(port);
		const began = Date.now();
		for (const byte of v1('198.51.100.7')) {
			if (client.closed) break;
			client.write(new Uint8Array([byte]));
			await Bun.sleep(100);
		}
		expect(client.closed).toBe(true);
		expect(Date.now() - began).toBeLessThan(2_000);
		expect(client.received).toBe('');
	});

	test('stop(true) with headers pending: nothing written, nothing reported', async () => {
		const { port, errors } = await start();
		const pending = [await connect(port), await connect(port, 'PROXY ')];
		await Bun.sleep(50);
		expect(() => server?.stop(true)).not.toThrow();
		for (const client of pending) {
			await client.until(() => false, 1);
			expect(client.closed).toBe(true);
			expect(client.received).toBe('');
		}
		expect(errors).toEqual([]);
	});
});

describe('an untrusted peer', () => {
	test('a PROXY header is just bad input, and never sets the address', async () => {
		const { port, seen } = await start({
			proxyProtocol: { trusted: ['192.0.2.1'] },
		});
		const client = await connect(port, v1('198.51.100.7'));
		expect(await client.line()).toContain('IMAP4rev2 ready');
		expect(await client.line()).toStartWith('PROXY BAD');
		expect(await logIn(client)).toStartWith('b OK');
		expect(seen).toEqual(['127.0.0.1']);
	});
});
