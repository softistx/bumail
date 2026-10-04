import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from './client.fixtures';
import type { SmtpServerOptions } from './options';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

const TOO_MANY =
	'421 4.7.0 foo.com Too many connections from your address, try later\r\n';

let server: SmtpServer | undefined;
const clients: Client[] = [];
afterEach(() => {
	for (const client of clients.splice(0)) client.end();
	server?.stop(true);
	server = undefined;
});

async function start(
	overrides: Partial<SmtpServerOptions> = {},
	hostname = '127.0.0.1',
) {
	server = createSmtpServer(mxOptions({ tls, ...overrides }));
	const { port } = await server.listen({ port: 0, hostname });
	return port;
}

/** A client that got its greeting, or its refusal: the reply it read first. */
async function connect(
	port: number,
	hostname = '127.0.0.1',
): Promise<{ client: Client; first: string }> {
	const client = await Client.connect(port, false, hostname);
	clients.push(client);
	return { client, first: await client.reply() };
}

async function counted(expected: number): Promise<number | undefined> {
	for (let i = 0; i < 100 && server?.connections !== expected; i++)
		await Bun.sleep(20);
	return server?.connections;
}

/** Whether `::1` can be listened on and reached here. */
async function ipv6Loopback(): Promise<boolean> {
	try {
		const probe = Bun.listen({
			hostname: '::1',
			port: 0,
			socket: { data() {} },
		});
		probe.stop(true);
		return true;
	} catch {
		return false;
	}
}

describe('maxConnectionsPerClient', () => {
	test('one more from the same address is turned away with 421 4.7.0 and closed', async () => {
		const port = await start({ maxConnectionsPerClient: 2 });
		expect((await connect(port)).first).toStartWith('220');
		expect((await connect(port)).first).toStartWith('220');
		const third = await connect(port);
		expect(third.first).toBe(TOO_MANY);
		expect(await third.client.until(() => third.client.closed, 2)).toBe(true);
		expect(server?.connections).toBe(2);
	});

	test('the default is 10', async () => {
		const port = await start();
		for (let i = 0; i < 10; i++)
			expect((await connect(port)).first).toStartWith('220');
		expect((await connect(port)).first).toBe(TOO_MANY);
	});

	test('maxConnections still answers 421 4.3.2 first', async () => {
		const port = await start({
			maxConnections: 1,
			maxConnectionsPerClient: 1,
		});
		await connect(port);
		expect((await connect(port)).first).toBe(
			'421 4.3.2 foo.com Too many connections, try later\r\n',
		);
	});

	test('a slot is freed by QUIT', async () => {
		const port = await start({ maxConnectionsPerClient: 1 });
		const { client } = await connect(port);
		expect((await connect(port)).first).toBe(TOO_MANY);
		expect(await client.command('QUIT')).toStartWith('221');
		expect(await counted(0)).toBe(0);
		expect((await connect(port)).first).toStartWith('220');
	});

	test('a slot is freed when the client hangs up, after STARTTLS too', async () => {
		const port = await start({ maxConnectionsPerClient: 1 });
		const { client } = await connect(port);
		await client.command('EHLO bar.com');
		await client.command('STARTTLS');
		await client.startTls();
		await client.command('EHLO bar.com');
		expect((await connect(port)).first).toBe(TOO_MANY);
		client.end();
		expect(await counted(0)).toBe(0);
		expect((await connect(port)).first).toStartWith('220');
	});

	test('a slot is freed by the idle timeout', async () => {
		const port = await start({ maxConnectionsPerClient: 1, timeout: 1 });
		const { client } = await connect(port);
		expect(await client.reply()).toBe('421 foo.com Idle too long, closing\r\n');
		expect(await counted(0)).toBe(0);
		expect((await connect(port)).first).toStartWith('220');
	}, 8000);

	test('a slot is freed by maxErrors', async () => {
		const port = await start({ maxConnectionsPerClient: 1, maxErrors: 1 });
		const { client } = await connect(port);
		await client.command('EHLO bar.com');
		expect(await client.command('BOGUS')).toBe(
			'421 4.7.0 foo.com Too many errors, closing\r\n',
		);
		expect(await counted(0)).toBe(0);
		expect((await connect(port)).first).toStartWith('220');
	});

	test('a slot is freed when onConnect refuses', async () => {
		let refuse = true;
		const port = await start({
			maxConnectionsPerClient: 1,
			onConnect: () =>
				refuse ? { code: 554, status: '5.7.1', text: 'Go away' } : undefined,
		});
		expect((await connect(port)).first).toStartWith('554');
		expect(await counted(0)).toBe(0);
		refuse = false;
		expect((await connect(port)).first).toStartWith('220');
	});

	test('stop(true) counts every client out', async () => {
		const port = await start({ maxConnectionsPerClient: 2 });
		await connect(port);
		await connect(port);
		server?.stop(true);
		expect(await counted(0)).toBe(0);
	});

	test('on a dual-stack listener, an IPv4 client (::ffff:127.0.0.1) and ::1 are two clients', async () => {
		if (!(await ipv6Loopback())) {
			console.warn('skipped: no IPv6 loopback here');
			return;
		}
		const seen: string[] = [];
		const port = await start(
			{
				maxConnectionsPerClient: 1,
				onConnect: (session) => {
					seen.push(session.remoteAddress);
				},
			},
			'::',
		);
		expect((await connect(port)).first).toStartWith('220');
		expect(seen[0]).toBe('::ffff:127.0.0.1');
		// The mapped address counts as the IPv4 one: the same client.
		expect((await connect(port)).first).toBe(TOO_MANY);
		// ::1 is another /64: another client.
		expect((await connect(port, '::1')).first).toStartWith('220');
		expect((await connect(port, '::1')).first).toBe(TOO_MANY);
		expect(server?.connections).toBe(2);
	});
});
