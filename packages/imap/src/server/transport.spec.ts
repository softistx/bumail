import { afterEach, describe, expect, test } from 'bun:test';
import type { TCPSocketListener } from 'bun';
import { localhostTls, slowTlsReader } from './client.fixtures';
import { CLOSE_GRACE, SocketTransport } from './transport';

const listeners: TCPSocketListener<{ transport?: SocketTransport }>[] = [];
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.stop(true);
});

/** 8 MiB: more than the socket and the kernel take at once, so most of it queues. */
const SIZE = 8 * 1024 * 1024;

/**
 * A TLS listener that writes SIZE bytes through a SocketTransport and
 * hangs up at once, recording what was still queued at `end()`.
 */
async function hangUpWithBytesQueued() {
	const ended: { backlog: number; at: number }[] = [];
	const listener = Bun.listen<{ transport?: SocketTransport }>({
		hostname: '127.0.0.1',
		port: 0,
		tls: await localhostTls(),
		socket: {
			open(socket) {
				const transport = new SocketTransport(socket as never, true, () => {});
				socket.data = { transport };
				transport.write(new Uint8Array(SIZE).fill(0x79));
				ended.push({ backlog: transport.backlog, at: Date.now() });
				transport.end();
			},
			drain(socket) {
				socket.data.transport?.drain();
			},
			close(socket) {
				socket.data.transport?.closed();
			},
		},
	});
	listeners.push(listener);
	return { port: listener.port, ended };
}

describe('SocketTransport on a real TLS socket', () => {
	test('end() with bytes queued: drain sends every one, then shutdown closes, before the grace', async () => {
		const { port, ended } = await hangUpWithBytesQueued();
		const client = slowTlsReader(port);
		const started = Date.now();
		while (!client.closed && Date.now() - started < 10_000) {
			await Bun.sleep(20);
		}
		expect(client.closed).toBe(true);
		expect(ended).toHaveLength(1);
		expect(ended[0]?.backlog).toBeGreaterThan(0);
		const text = client.text();
		expect(text.length).toBe(SIZE);
		expect(text).toBe('y'.repeat(SIZE));
		// A shutdown after the drain, not the grace timer's terminate.
		expect(Date.now() - (ended[0]?.at ?? 0)).toBeLessThan(CLOSE_GRACE);
	}, 15_000);

	test('end() with bytes queued, to a slow reader: every byte, then the close', async () => {
		const { port, ended } = await hangUpWithBytesQueued();
		const client = slowTlsReader(port);
		client.sip();
		const started = Date.now();
		while (!client.closed && Date.now() - started < 10_000) {
			client.socket.resume();
			await Bun.sleep(5);
		}
		expect(client.closed).toBe(true);
		expect(ended[0]?.backlog).toBeGreaterThan(0);
		expect(client.text()).toBe('y'.repeat(SIZE));
		expect(Date.now() - (ended[0]?.at ?? 0)).toBeLessThan(CLOSE_GRACE);
	}, 15_000);
});
