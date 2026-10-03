import { afterEach, describe, expect, jest, test } from 'bun:test';
import type { Socket } from 'bun';
import { CLOSE_GRACE_MS, SocketTransport } from './transport';

/** A socket that takes at most `room` bytes per write, as a full kernel buffer does. */
function slowSocket(room: number) {
	const sent: number[] = [];
	let ended = false;
	let terminated = false;
	const shutdowns: unknown[] = [];
	const calls: string[] = [];
	const socket = {
		remoteAddress: '192.0.2.10',
		write: (bytes: Uint8Array) => {
			calls.push('write');
			const taken = Math.min(room, bytes.length);
			sent.push(...bytes.subarray(0, taken));
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

describe('SocketTransport keeps what the socket could not take', () => {
	test('a partial write: the rest leaves on drain, in order, and drained() waits for it', async () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('250 first\r\n');
		transport.write('250 second\r\n');
		expect(fake.text()).toBe('250 ');
		let drained = false;
		const waiting = transport.drained().then(() => {
			drained = true;
		});
		for (let i = 0; i < 10 && !drained; i++) {
			transport.drain();
			await Bun.sleep(0);
		}
		await waiting;
		expect(fake.text()).toBe('250 first\r\n250 second\r\n');
	});

	test('end() waits for what is queued, then hangs up with shutdown(true)', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('221 bye\r\n');
		transport.end();
		expect(fake.ended).toBe(false);
		transport.drain();
		transport.drain();
		expect(fake.text()).toBe('221 bye\r\n');
		expect(fake.ended).toBe(true);
		expect(fake.shutdowns).toEqual([true]);
	});

	test('end() on TLS behind a queue: a full shutdown() once it drained, not a half-close', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.write('221 bye\r\n');
		transport.end();
		transport.drain();
		transport.drain();
		expect(fake.text()).toBe('221 bye\r\n');
		// The last write may still sit in Bun's TLS buffer: a half-close drops it.
		expect(fake.shutdowns).toEqual([undefined]);
	});

	test('a write the socket refuses (-1) queues all of it, not its last byte', () => {
		const sent: string[] = [];
		let room = -1;
		const socket = {
			remoteAddress: '192.0.2.10',
			write: (bytes: Uint8Array) => {
				if (room < 0) return -1;
				sent.push(new TextDecoder().decode(bytes));
				return bytes.length;
			},
		} as unknown as Socket<unknown>;
		const transport = new SocketTransport(socket, false, () => {});
		transport.write('250 OK\r\n');
		room = 1;
		transport.drain();
		expect(sent.join('')).toBe('250 OK\r\n');
	});
});

describe('SocketTransport.abort never waits on a client that stopped reading', () => {
	test('with a backlog: the queue is dropped and the socket terminated at once', async () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('250 first\r\n');
		transport.write('421 bye\r\n');
		const waiting = transport.drained();
		transport.abort();
		expect(fake.terminated).toBe(true);
		expect(fake.ended).toBe(false);
		// Whoever waited for the backlog is let go.
		await waiting;
		transport.drain();
		expect(fake.text()).toBe('250 ');
	});

	test('with nothing queued: the reply has left, so the socket ends gracefully', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('421 bye\r\n');
		transport.abort();
		expect(fake.text()).toBe('421 bye\r\n');
		expect(fake.ended).toBe(true);
		expect(fake.terminated).toBe(false);
	});

	test('with nothing queued but reading paused: reads again, then half-closes, as a half-close waits on unread input', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.write('421 bye\r\n');
		transport.abort();
		expect(fake.calls).toEqual(['pause', 'write', 'resume', 'shutdown']);
		expect(fake.shutdowns).toEqual([true]);
		expect(fake.terminated).toBe(false);
	});

	test('reading paused, then resumed: nothing queued ends gracefully again', () => {
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.pause();
		transport.resume();
		transport.abort();
		expect(fake.shutdowns).toEqual([true]);
		expect(fake.terminated).toBe(false);
	});

	test('after a graceful end() that is still waiting: abort() terminates', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('221 bye\r\n');
		transport.end();
		expect(fake.ended).toBe(false);
		transport.abort();
		expect(fake.terminated).toBe(true);
	});
});

describe('a hang-up while the server paused reading', () => {
	test('end() reads again only once what is queued has left, then hangs up', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.pause();
		transport.write('221 bye\r\n');
		transport.end();
		expect(fake.calls).not.toContain('resume');
		while (!fake.ended) transport.drain();
		expect(fake.calls.slice(-2)).toEqual(['resume', 'shutdown']);
		// On TLS after a drain: the full shutdown, as when not paused.
		expect(fake.shutdowns).toEqual([undefined]);
		expect(fake.terminated).toBe(false);
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
		transport.write('221 bye\r\n');
		transport.end();
		expect(fake.shutdowns).toEqual([true]);
		jest.advanceTimersByTime(CLOSE_GRACE_MS - 1);
		expect(fake.terminated).toBe(false);
		jest.advanceTimersByTime(1);
		expect(fake.terminated).toBe(true);
	});

	test('end() behind a backlog that never leaves: terminated once the grace is up', () => {
		jest.useFakeTimers();
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('221 bye\r\n');
		transport.end();
		jest.advanceTimersByTime(CLOSE_GRACE_MS);
		expect(fake.ended).toBe(false);
		expect(fake.terminated).toBe(true);
	});

	test('abort() with nothing queued: hung up, and bounded by the same grace', () => {
		jest.useFakeTimers();
		const fake = slowSocket(100);
		const transport = new SocketTransport(fake.socket, true, () => {});
		transport.write('421 bye\r\n');
		transport.abort();
		expect(fake.ended).toBe(true);
		expect(fake.terminated).toBe(false);
		jest.advanceTimersByTime(CLOSE_GRACE_MS);
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
		transport.write('421 bye\r\n');
		expect(jest.getTimerCount()).toBe(0);
		jest.advanceTimersByTime(CLOSE_GRACE_MS * 2);
		expect(fake.calls).toEqual([]);
	});

	test('closed() first, with bytes queued: abort() and end() touch no socket', () => {
		jest.useFakeTimers();
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('250 first\r\n');
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
		jest.advanceTimersByTime(10);
		expect(fake.terminated).toBe(true);
	});
});

describe('SocketTransport restarts the idle time', () => {
	test('restartIdle sets the socket timeout again', () => {
		const timeouts: number[] = [];
		const socket = {
			remoteAddress: '192.0.2.10',
			timeout: (seconds: number) => {
				timeouts.push(seconds);
			},
		} as unknown as Socket<unknown>;
		new SocketTransport(socket, false, () => {}).restartIdle(300);
		expect(timeouts).toEqual([300]);
	});
});
