import { afterEach, describe, expect, test } from 'bun:test';
import type { Socket as NetSocket } from 'node:net';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { front } from './front.fixtures';
import { v2 } from './proxy/headers.fixtures';
import { createSmtpServer, type SmtpServer } from './server';
import { mxOptions } from './session.fixtures';

const fixture = (name: string) =>
	Bun.file(new URL(`./fixtures/${name}`, import.meta.url));
const tls = {
	key: await fixture('localhost.key').text(),
	cert: await fixture('localhost.crt').text(),
};

let server: SmtpServer | undefined;
const sockets: (NetSocket | TLSSocket)[] = [];
const fronts: { close(): void }[] = [];
afterEach(() => {
	for (const socket of sockets.splice(0)) socket.destroy();
	for (const proxy of fronts.splice(0)) proxy.close();
	server?.stop(true);
	server = undefined;
});

/** Implicit TLS behind a trusted proxy; a client over `node:tls`, through it. */
async function start(timeout: number) {
	server = createSmtpServer(
		mxOptions({
			tls,
			implicitTls: true,
			timeout,
			proxyProtocol: { trusted: ['127.0.0.1'] },
		}),
	);
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const proxy = await front(port, v2({ source: '198.51.100.7' }), {
		coalesce: true,
	});
	fronts.push(proxy);
	const socket = await new Promise<TLSSocket>((done, fail) => {
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
	return socket;
}

/** Resolves with the next complete reply on `socket`. */
function reply(socket: NetSocket): Promise<string> {
	return new Promise((done) => {
		let text = '';
		const read = (chunk: Buffer) => {
			text += chunk.toString('latin1');
			if (/(^|\n)\d{3} [^\n]*\n$/.test(text)) {
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

// As quiet.spec.ts, over ProxiedTls: a client that stops reading never
// holds a slot past the idle time, nor past its QUIT.
describe('a client that stops reading, through implicit TLS behind a proxy', () => {
	test('is counted out at the idle timeout, and reads the 421 and a clean end once it reads again', async () => {
		const socket = await start(1);
		await reply(socket);
		socket.write('EHLO bar.com\r\n');
		await reply(socket);
		socket.pause();
		expect(await within(500, () => server?.connections === 1)).toBe(true);
		// Bun's socket timer ticks in steps of about 4 s, then the close is bounded by the grace.
		expect(await within(7000, () => server?.connections === 0)).toBe(true);
		let text = '';
		let ended = false;
		socket.on('data', (chunk: Buffer) => {
			text += chunk.toString('latin1');
		});
		socket.on('end', () => {
			ended = true;
		});
		socket.resume();
		expect(await within(2000, () => ended)).toBe(true);
		expect(text).toBe('421 4.4.2 foo.com Idle too long, closing\r\n');
	}, 15_000);

	test('QUIT, then no more reading: counted out at once, the 221 read later', async () => {
		const socket = await start(300);
		await reply(socket);
		socket.write('QUIT\r\n');
		socket.pause();
		expect(await within(1000, () => server?.connections === 0)).toBe(true);
		const closing = reply(socket);
		socket.resume();
		expect(await closing).toStartWith('221 ');
	}, 15_000);
});
