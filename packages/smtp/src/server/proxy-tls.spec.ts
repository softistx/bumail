import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from './client.fixtures';
import { front } from './front.fixtures';
import type { SmtpServerOptions } from './options';
import { v1, v2 } from './proxy/headers.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
// The key as a BunFile: the TLS behind a proxy reads it, as Bun.listen would.
const tls = {
	key: fixture('localhost.key'),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
const clients: Client[] = [];
const fronts: { close(): void }[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.end();
	for (const proxy of fronts.splice(0)) proxy.close();
	server?.stop(true);
	server = undefined;
});

/** Implicit TLS behind a trusted proxy, and who `onConnect` saw. */
async function start(overrides: Partial<SmtpServerOptions> = {}) {
	const seen: string[] = [];
	const errors: unknown[] = [];
	server = createSmtpServer(
		mxOptions({
			tls,
			implicitTls: true,
			proxyProtocol: { trusted: ['127.0.0.1'] },
			onConnect: (session) => {
				seen.push(`${session.remoteAddress} ${session.secure}`);
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

/** A TLS client through a proxy that sends `header` in front of what the client sends. */
async function through(port: number, header: Uint8Array, coalesce = true) {
	const proxy = await front(port, header, { coalesce });
	fronts.push(proxy);
	const client = await Client.connect(proxy.port, true);
	clients.push(client);
	return client;
}

async function counted(expected: number, seconds = 2) {
	const end = Date.now() + seconds * 1000;
	while (server?.connections !== expected && Date.now() < end)
		await Bun.sleep(20);
	return server?.connections;
}

describe('implicit TLS behind a trusted proxy', () => {
	test('the header and the ClientHello in one segment: greeted over TLS, the client the source', async () => {
		const { port, seen } = await start();
		const client = await through(port, v2({ source: '198.51.100.7' }));
		expect(await client.reply()).toBe('220 foo.com ESMTP ready\r\n');
		expect(seen).toEqual(['198.51.100.7 true']);
	});

	test('the header, then the ClientHello on its own', async () => {
		const { port, seen } = await start();
		const client = await through(port, v1('2001:db8::7'), false);
		expect(await client.reply()).toStartWith('220');
		expect(seen).toEqual(['2001:db8::7 true']);
	});

	test('a session through it: a message of 1 MiB, then QUIT and a clean end', async () => {
		const sizes: number[] = [];
		const { port } = await start({
			onData: async (message) => {
				sizes.push(
					(await new Response(message.content).arrayBuffer()).byteLength,
				);
			},
		});
		const client = await through(port, v2({ source: '198.51.100.7' }));
		await client.reply();
		await client.command('EHLO client.example');
		await client.command('MAIL FROM:<a@b.example>');
		await client.command('RCPT TO:<c@foo.com>');
		expect(await client.command('DATA')).toStartWith('354');
		const line = `${'x'.repeat(1022)}\r\n`;
		client.write(`Subject: big\r\n\r\n${line.repeat(1024)}.\r\n`);
		expect(await client.reply()).toStartWith('250');
		expect(sizes[0]).toBeGreaterThan(1024 * 1024);
		expect(await client.command('QUIT')).toStartWith('221');
		await client.until(() => false, 2);
		expect(client.closed).toBe(true);
		expect(await counted(0)).toBe(0);
	});

	test('maxConnectionsPerClient counts the client behind the header', async () => {
		const { port } = await start({ maxConnectionsPerClient: 1 });
		expect(await (await through(port, v1('198.51.100.1'))).reply()).toStartWith(
			'220',
		);
		expect(await (await through(port, v1('198.51.100.2'))).reply()).toStartWith(
			'220',
		);
		const again = await through(port, v1('198.51.100.1'));
		expect(await again.reply()).toStartWith('421 4.7.0');
	});

	test('the idle timeout says 421 over it and frees the slot', async () => {
		const { port } = await start({ timeout: 1 });
		const client = await through(port, v2({ source: '198.51.100.7' }));
		await client.reply();
		expect(
			await client.until(
				(text) => text.includes('421 foo.com Idle too long'),
				7,
			),
		).toBe(true);
		expect(await counted(0, 2)).toBe(0);
	}, 12_000);

	test('a ClientHello that never comes: counted, then closed at handshakeTimeout', async () => {
		const { port, seen } = await start({ handshakeTimeout: 1 });
		const client = await Client.connect(port);
		clients.push(client);
		client.write(v2({ source: '198.51.100.7' }));
		expect(await counted(1)).toBe(1);
		// Bun's socket timer ticks in steps of about 4 s.
		expect(await counted(0, 7)).toBe(0);
		expect(client.received).toBe('');
		expect(seen).toEqual([]);
	}, 12_000);

	test('garbage where the ClientHello should be: counted out at once', async () => {
		const { port, errors } = await start();
		const client = await Client.connect(port);
		clients.push(client);
		client.write(v2({ source: '198.51.100.7' }));
		client.write('EHLO client.example\r\n');
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(await counted(0)).toBe(0);
		expect(errors).toEqual([]);
	});

	test('stop(true) with a handshake pending behind its header: reset, nothing written', async () => {
		const { port, errors } = await start();
		const client = await Client.connect(port);
		clients.push(client);
		client.write(v1('198.51.100.7'));
		expect(await counted(1)).toBe(1);
		expect(() => server?.stop(true)).not.toThrow();
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(client.received).toBe('');
		expect(errors).toEqual([]);
	});
});

describe('implicit TLS with proxyProtocol, from a peer not trusted', () => {
	test('a TLS client straight to the port is served as without it', async () => {
		const { port, seen } = await start({
			proxyProtocol: { trusted: ['192.0.2.1'] },
		});
		const client = await Client.connect(port, true);
		clients.push(client);
		expect(await client.reply()).toBe('220 foo.com ESMTP ready\r\n');
		expect(seen).toEqual(['127.0.0.1 true']);
	});

	test('a header from it is no ClientHello: closed, never greeted', async () => {
		const { port, seen } = await start({
			proxyProtocol: { trusted: ['192.0.2.1'] },
		});
		const client = await Client.connect(port);
		clients.push(client);
		client.write(v1('198.51.100.7'));
		await client.until(() => false, 1);
		expect(client.closed).toBe(true);
		expect(seen).toEqual([]);
		expect(await counted(0)).toBe(0);
	});
});

describe('a clear port with proxyProtocol, from a peer not trusted', () => {
	const untrusted = {
		implicitTls: false,
		proxyProtocol: { trusted: ['10.0.0.0/8'] },
	};

	test('a PROXY header is just bad input, and never sets the address', async () => {
		const { port, seen } = await start(untrusted);
		const client = await Client.connect(port);
		clients.push(client);
		expect(await client.reply()).toStartWith('220');
		expect(
			await client.command('PROXY TCP4 198.51.100.7 192.0.2.1 1 25'),
		).toStartWith('500');
		expect(seen).toEqual(['127.0.0.1 false']);
	});

	test('one that sends it before the greeting talked first', async () => {
		const { port, seen } = await start({ ...untrusted, greetingDelay: 0.2 });
		const client = await Client.connect(port);
		clients.push(client);
		client.write(v1('198.51.100.7'));
		expect(await client.reply()).toBe(
			'554 foo.com Talked before the greeting\r\n',
		);
		expect(seen).toEqual(['127.0.0.1 false']);
	});
});
