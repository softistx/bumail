import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from './client.fixtures';
import type { SmtpServerOptions } from './options';
import { concat, v1, v2 } from './proxy/headers.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
const clients: Client[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.end();
	server?.stop(true);
	server = undefined;
});

/** A server trusting the specs' own address as its proxy, and who `onConnect` saw. */
async function start(overrides: Partial<SmtpServerOptions> = {}) {
	const seen: string[] = [];
	const errors: unknown[] = [];
	server = createSmtpServer(
		mxOptions({
			proxyProtocol: { trusted: ['127.0.0.1', '::1'] },
			onConnect: (session) => {
				seen.push(session.remoteAddress);
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

/** Connects, sends `first` at once, and keeps the client for clean-up. */
async function connect(port: number, first?: Uint8Array | string) {
	const client = await Client.connect(port);
	clients.push(client);
	if (first !== undefined) client.write(first);
	return client;
}

async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

describe('a trusted proxy', () => {
	test('the client is the source: in onConnect, every hook and the Received field', async () => {
		const from: string[] = [];
		const texts: string[] = [];
		const { port, seen } = await start({
			onMailFrom: (_, session) => {
				from.push(session.remoteAddress);
			},
			onData: async (message) => {
				texts.push(await new Response(message.content).text());
			},
		});
		const client = await connect(port, v1('198.51.100.7'));
		expect(await client.reply()).toBe('220 foo.com ESMTP ready\r\n');
		await client.command('EHLO client.example');
		await client.command('MAIL FROM:<a@b.example>');
		await client.command('RCPT TO:<c@foo.com>');
		await client.command('DATA');
		await client.command('Subject: x\r\n\r\nhi\r\n.');
		expect(seen).toEqual(['198.51.100.7']);
		expect(from).toEqual(['198.51.100.7']);
		expect(texts[0]).toContain('([198.51.100.7])');
	});

	test('v2 over IPv6; v2 LOCAL, v1 UNKNOWN and v2 UNSPEC keep the peer', async () => {
		const { port, seen } = await start();
		for (const header of [
			v2({ source: '2001:db8::7' }),
			v2({ command: 0, family: 0 }),
			new TextEncoder().encode('PROXY UNKNOWN\r\n'),
			v2({ family: 0 }),
		]) {
			const client = await connect(port, header);
			expect(await client.reply()).toStartWith('220');
		}
		expect(seen).toEqual([
			'2001:db8::7',
			'127.0.0.1',
			'127.0.0.1',
			'127.0.0.1',
		]);
	});

	test('the header split over many writes', async () => {
		const { port, seen } = await start();
		const client = await connect(port);
		for (const byte of v2({ source: '203.0.113.5' })) {
			client.write(new Uint8Array([byte]));
			await Bun.sleep(2);
		}
		expect(await client.reply()).toStartWith('220');
		expect(seen).toEqual(['203.0.113.5']);
	});

	test('what the client sent behind the header is its own, before the greeting: refused', async () => {
		const { port } = await start({ greetingDelay: 0.2 });
		const client = await connect(
			port,
			concat(v1('198.51.100.7'), 'EHLO x\r\n'),
		);
		expect(await client.reply()).toBe(
			'554 foo.com Talked before the greeting\r\n',
		);
	});

	test('maxConnectionsPerClient counts clients, not the proxy', async () => {
		const { port } = await start({ maxConnectionsPerClient: 1 });
		for (const source of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
			expect(await (await connect(port, v1(source))).reply()).toStartWith(
				'220',
			);
		}
		expect(await counted(3)).toBe(3);
		const again = await connect(port, v2({ source: '198.51.100.2' }));
		expect(await again.reply()).toBe(
			'421 4.7.0 foo.com Too many connections from your address, try later\r\n',
		);
		// An IPv6 client by its /64, through the header too.
		await (await connect(port, v1('2001:db8:1:2::1'))).reply();
		const sibling = await connect(port, v1('2001:db8:1:2::ffff'));
		expect(await sibling.reply()).toStartWith('421 4.7.0');
	});

	test('a socket awaiting its header holds no slot', async () => {
		const { port } = await start({ maxConnectionsPerClient: 1 });
		await connect(port);
		await connect(port);
		await Bun.sleep(100);
		expect(server?.connections).toBe(0);
		const client = await connect(port, v1('198.51.100.9'));
		expect(await client.reply()).toStartWith('220');
	});

	test('STARTTLS after the header: the client stays the source', async () => {
		const from: string[] = [];
		const { port } = await start({
			tls,
			onMailFrom: (_, session) => {
				from.push(`${session.remoteAddress} ${session.secure}`);
			},
		});
		const client = await connect(port, v1('198.51.100.7'));
		await client.reply();
		await client.command('EHLO client.example');
		expect(await client.command('STARTTLS')).toStartWith('220');
		await client.startTls();
		await client.command('EHLO client.example');
		await client.command('MAIL FROM:<a@b.example>');
		expect(from).toEqual(['198.51.100.7 true']);
	});
});

describe('a trusted proxy that sends no valid header is closed, without a word', () => {
	async function refused(first: Uint8Array | string, seconds = 2) {
		const { port, seen, errors } = await start({ handshakeTimeout: 1 });
		const client = await connect(port, first);
		const start_ = Date.now();
		await client.until(() => false, seconds);
		expect(client.closed).toBe(true);
		expect(client.received).toBe('');
		expect(seen).toEqual([]);
		expect(errors).toEqual([]);
		expect(server?.connections).toBe(0);
		return Date.now() - start_;
	}

	test('garbage: an SMTP command first', async () => {
		expect(await refused('EHLO client.example\r\n')).toBeLessThan(500);
	});

	test('a v1 line past 107 bytes', async () => {
		expect(await refused(`PROXY UNKNOWN ${'x'.repeat(120)}`)).toBeLessThan(500);
	});

	test('v2 announcing more TLVs than allowed', async () => {
		const header = v2({ source: '198.51.100.7', length: 65_535 });
		expect(await refused(header.subarray(0, 16))).toBeLessThan(500);
	});

	test('a truncated header, at handshakeTimeout', async () => {
		const elapsed = await refused(
			v2({ source: '198.51.100.7' }).subarray(0, 20),
		);
		expect(elapsed).toBeGreaterThanOrEqual(900);
	});

	test('a slowloris, a byte at a time, at handshakeTimeout however it trickles', async () => {
		const { port, seen } = await start({ handshakeTimeout: 1 });
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
		expect(seen).toEqual([]);
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
