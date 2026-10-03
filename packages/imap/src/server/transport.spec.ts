import { afterEach, describe, expect, jest, test } from 'bun:test';
import type { Socket, TCPSocketListener } from 'bun';
import { localhostTls, slowTlsReader } from './client.fixtures';
import {
	CLOSE_GRACE_MS,
	LINGER_MAX_MS,
	LINGER_QUIET_MS,
	SocketTransport,
} from './transport';

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
		expect(Date.now() - (ended[0]?.at ?? 0)).toBeLessThan(CLOSE_GRACE_MS);
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
		expect(Date.now() - (ended[0]?.at ?? 0)).toBeLessThan(CLOSE_GRACE_MS);
	}, 15_000);
});

const bytes = (text: string) => new TextEncoder().encode(text);

/** A socket that takes at most `room` bytes per write, as a full kernel buffer does. */
function slowSocket(room: number) {
	const sent: number[] = [];
	let ended = false;
	let terminated = false;
	const shutdowns: unknown[] = [];
	const calls: string[] = [];
	const socket = {
		remoteAddress: '192.0.2.10',
		write: (chunk: Uint8Array) => {
			calls.push('write');
			const taken = Math.min(room, chunk.length);
			sent.push(...chunk.subarray(0, taken));
			return taken;
		},
		end: () => {
			throw new Error(
				'end() waits on a TLS client: the transport uses shutdown()',
			);
		},
		shutdown: (halfClose?: boolean) => {
			calls.push('shutdown');
			shutdowns.push(halfClose);
			ended = true;
		},
		terminate: () => {
			calls.push('terminate');
			terminated = true;
		},
		pause: () => calls.push('pause'),
		resume: () => calls.push('resume'),
	} as unknown as Socket<unknown>;
	return {
		socket,
		text: () => new TextDecoder().decode(new Uint8Array(sent)),
		get ended() {
			return ended;
		},
		get terminated() {
			return terminated;
		},
		/** The argument of every `shutdown` call. */
		shutdowns,
		/** Every socket method called, in order. */
		calls,
	};
}

describe('SocketTransport hangs up with a half-close', () => {
	test('end() with nothing queued: shutdown(true) at once', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.write(bytes('* BYE Logging out\r\n'));
		transport.end();
		expect(fake.shutdowns).toEqual([true]);
		expect(fake.terminated).toBe(false);
	});

	test('end() waits for what is queued, then shutdown(true)', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write(bytes('* BYE bye\r\n'));
		transport.end();
		expect(fake.ended).toBe(false);
		transport.drain();
		transport.drain();
		transport.drain();
		expect(fake.text()).toBe('* BYE bye\r\n');
		expect(fake.shutdowns).toEqual([true]);
	});
});

describe('SocketTransport keeps the tail of a drained queue on TLS', () => {
	test('end() on TLS behind a queue: a full shutdown() once it drained, not a half-close', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.write(bytes('* BYE bye\r\n'));
		transport.end();
		transport.drain();
		transport.drain();
		transport.drain();
		expect(fake.text()).toBe('* BYE bye\r\n');
		expect(fake.shutdowns).toEqual([undefined]);
	});
});

describe('SocketTransport.abort never waits on a client that stopped reading', () => {
	test('with a backlog: the queue is dropped and the socket terminated at once', async () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write(bytes('* 1 FETCH (FLAGS ())\r\n'));
		const waiting = transport.drained();
		transport.abort();
		expect(fake.terminated).toBe(true);
		expect(fake.ended).toBe(false);
		expect(transport.backlog).toBe(0);
		// Whoever waited for the backlog is let go.
		await waiting;
	});

	test('with nothing queued: the BYE has left, so the socket half-closes', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write(bytes('* BYE Idle for too long, closing\r\n'));
		transport.abort();
		expect(fake.shutdowns).toEqual([true]);
		expect(fake.terminated).toBe(false);
	});

	test('with nothing queued but reading paused: reads again, lingers, then half-closes', () => {
		jest.useFakeTimers();
		try {
			const fake = slowSocket(100);
			const transport = new SocketTransport(fake.socket, false, () => {});
			transport.pause();
			transport.write(bytes('* BYE Idle for too long, closing\r\n'));
			transport.abort();
			expect(fake.calls).toEqual(['pause', 'write', 'resume']);
			jest.advanceTimersByTime(LINGER_QUIET_MS);
			expect(fake.calls).toEqual(['pause', 'write', 'resume', 'shutdown']);
			expect(fake.shutdowns).toEqual([true]);
			expect(fake.terminated).toBe(false);
		} finally {
			jest.useRealTimers();
		}
	});

	test('reading paused, then resumed: nothing queued half-closes again', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.resume();
		transport.abort();
		expect(fake.shutdowns).toEqual([true]);
		expect(fake.terminated).toBe(false);
	});
});

describe('a hang-up while the server paused reading', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	test('end() reads again only once what is queued has left, then hangs up', () => {
		jest.useFakeTimers();
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.pause();
		transport.write(bytes('* BYE Logging out\r\n'));
		transport.end();
		expect(fake.calls).not.toContain('resume');
		while (fake.calls.at(-1) !== 'resume') transport.drain();
		jest.advanceTimersByTime(LINGER_QUIET_MS);
		expect(fake.calls.slice(-2)).toEqual(['resume', 'shutdown']);
		// On TLS after a drain: the full shutdown, as when not paused.
		expect(fake.shutdowns).toEqual([undefined]);
		expect(fake.terminated).toBe(false);
	});

	test('it lingers while the client sends: each chunk puts the half-close back, until the input stops', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.abort();
		for (let i = 0; i < 5; i++) {
			jest.advanceTimersByTime(LINGER_QUIET_MS - 1);
			transport.received();
		}
		expect(fake.ended).toBe(false);
		jest.advanceTimersByTime(LINGER_QUIET_MS);
		expect(fake.shutdowns).toEqual([true]);
	});

	test('a client that sends on is half-closed after LINGER_MAX_MS all the same', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.abort();
		const start = Date.now();
		while (!fake.ended && Date.now() - start <= LINGER_MAX_MS) {
			jest.advanceTimersByTime(LINGER_QUIET_MS / 2);
			transport.received();
		}
		expect(fake.ended).toBe(true);
		expect(Date.now() - start).toBeLessThanOrEqual(LINGER_MAX_MS);
	});

	test('a second end() or abort() while it lingers does not half-close early; closed() stops it', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.end();
		transport.abort();
		transport.end();
		expect(fake.ended).toBe(false);
		transport.closed();
		jest.advanceTimersByTime(CLOSE_GRACE_MS * 2);
		expect(fake.calls).toEqual(['pause', 'resume']);
	});
});

describe('every end is bounded by CLOSE_GRACE_MS', () => {
	afterEach(() => {
		jest.useRealTimers();
	});

	test('end() with nothing queued: terminated once the grace is up, if close never came', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.end();
		jest.advanceTimersByTime(CLOSE_GRACE_MS - 1);
		expect(fake.terminated).toBe(false);
		jest.advanceTimersByTime(1);
		expect(fake.terminated).toBe(true);
	});

	test('end() behind a backlog that never leaves: terminated once the grace is up', () => {
		jest.useFakeTimers();
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write(bytes('* BYE bye\r\n'));
		transport.end();
		jest.advanceTimersByTime(CLOSE_GRACE_MS);
		expect(fake.ended).toBe(false);
		expect(fake.terminated).toBe(true);
	});

	test('closed() clears the timer: a socket that closed in time is left alone', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.end();
		transport.closed();
		jest.advanceTimersByTime(CLOSE_GRACE_MS * 2);
		expect(fake.terminated).toBe(false);
	});

	test('closed() first: a later abort(), end() or write() arms no timer and touches no socket', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.closed();
		transport.abort();
		transport.end();
		transport.write(bytes('* BYE bye\r\n'));
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(CLOSE_GRACE_MS * 2);
		expect(fake.calls).toEqual([]);
	});

	test('closed() first, with bytes queued: abort() and end() touch no socket', () => {
		jest.useFakeTimers();
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write(bytes('* 1 FETCH (FLAGS ())\r\n'));
		transport.closed();
		fake.calls.length = 0;
		transport.end();
		transport.abort();
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(CLOSE_GRACE_MS * 2);
		expect(fake.calls).toEqual([]);
	});

	test('a second end() or abort() does not push the deadline back', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.end();
		jest.advanceTimersByTime(CLOSE_GRACE_MS - 10);
		transport.abort();
		transport.end();
		jest.advanceTimersByTime(10);
		expect(fake.terminated).toBe(true);
	});
});
