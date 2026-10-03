import { describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import { SocketTransport } from './transport';

/** A socket that takes at most `room` bytes per write, as a full kernel buffer does. */
function slowSocket(room: number) {
	const sent: number[] = [];
	let ended = false;
	let terminated = false;
	const socket = {
		remoteAddress: '192.0.2.10',
		write: (bytes: Uint8Array) => {
			const taken = Math.min(room, bytes.length);
			sent.push(...bytes.subarray(0, taken));
			return taken;
		},
		end: () => {
			ended = true;
		},
		terminate: () => {
			terminated = true;
		},
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

	test('end() waits for what is queued, then hangs up', () => {
		const fake = slowSocket(4);
		const transport = new SocketTransport(fake.socket, false, () => {});
		transport.write('221 bye\r\n');
		transport.end();
		expect(fake.ended).toBe(false);
		transport.drain();
		transport.drain();
		expect(fake.text()).toBe('221 bye\r\n');
		expect(fake.ended).toBe(true);
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
