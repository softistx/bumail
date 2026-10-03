import { afterEach, describe, expect, test } from 'bun:test';
import { Client } from './client.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

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

/**
 * A client that pipelines commands and never reads a reply: the server's
 * replies fill the kernel's buffers, then its own queue. A close the server
 * decides on must still complete, or the connection keeps a slot of
 * `maxConnections` for good.
 */
/** An EHLO's reply is many times the command: the replies fill every buffer long before the commands do. */
const EHLOS = 'EHLO a\r\n'.repeat(200_000);
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

describe('a client that never reads is still disconnected', () => {
	test('idle timeout: the connection is counted out within a bound, and the socket closed', async () => {
		const port = await start({ timeout: 1 });
		const client = await neverReads(port, EHLOS);
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		// Bun checks socket timeouts every 4 seconds or so: 1 s of idle time is up within 6.
		expect(await within(6000, () => server?.connections === 0)).toBe(true);
		expect(await hungUp(client)).toBe(true);
	}, 12_000);

	test('such clients do not lock others out of maxConnections', async () => {
		const port = await start({ timeout: 1, maxConnections: 2 });
		const hostile = [
			await neverReads(port, EHLOS),
			await neverReads(port, EHLOS),
		];
		expect(await within(500, () => server?.connections === 2)).toBe(true);
		expect(await within(6000, () => server?.connections === 0)).toBe(true);
		const next = await Client.connect(port);
		expect(await next.reply()).toBe('220 foo.com ESMTP ready\r\n');
		next.end();
		for (const client of hostile) expect(await hungUp(client)).toBe(true);
	}, 12_000);

	test('QUIT behind replies the client never reads does not keep the slot either', async () => {
		const port = await start({ timeout: 1 });
		const client = await neverReads(port, `${EHLOS}QUIT\r\n`);
		expect(await within(6000, () => server?.connections === 0)).toBe(true);
		expect(await hungUp(client)).toBe(true);
	}, 12_000);
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
