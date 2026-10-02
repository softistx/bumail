import { describe, expect, test } from 'bun:test';
import type { Socket } from 'bun';
import { SocketTransport } from './transport';

/** A socket that takes at most `room` bytes per write, as a full kernel buffer does. */
function slowSocket(room: number) {
	const sent: number[] = [];
	let ended = false;
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
	} as unknown as Socket<unknown>;
	return {
		socket,
		text: () => new TextDecoder().decode(new Uint8Array(sent)),
		get ended() {
			return ended;
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
});
