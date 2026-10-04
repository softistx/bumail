import { describe, expect, test } from 'bun:test';
import { derToP1363, readDer, readInteger } from '../der/read.fixtures';
import { p1363ToDer } from './signature';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function p1363(r: number[], s: number[]): Uint8Array {
	const out = new Uint8Array(64);
	out.set(r, 32 - r.length);
	out.set(s, 64 - s.length);
	return out;
}

describe('p1363ToDer (RFC 3279 §2.2.3)', () => {
	test('r and s with their high bit set each get a 0x00', () => {
		const sig = new Uint8Array(64).fill(0x80);
		const der = p1363ToDer(sig);
		const [r, s] = readDer(der).children;
		expect(r?.content.length).toBe(33);
		expect(r?.content[0]).toBe(0);
		expect(s?.content.length).toBe(33);
		expect(der.length).toBe(2 + 35 + 35);
	});

	test('leading zeros are trimmed', () => {
		const der = p1363ToDer(p1363([0x01], [0x00, 0x7f]));
		expect(hex(der)).toBe('300602010102017f');
	});

	test('a half that is all zeros is INTEGER 0', () => {
		expect(hex(p1363ToDer(p1363([], [0x05])))).toBe('3006020100020105');
	});

	test('a trimmed half whose next byte has the high bit gets its 0x00 back', () => {
		const der = p1363ToDer(p1363([0x00, 0x00, 0x9a, 0x01], [0x42]));
		expect(hex(der)).toBe('30080203009a01020142');
	});

	test('round trip with the spec reader, over random signatures', () => {
		for (let i = 0; i < 200; i++) {
			const sig = crypto.getRandomValues(new Uint8Array(64));
			if (i % 3 === 0) sig.fill(0, 0, 1 + (i % 5));
			if (i % 4 === 0) sig[32] = 0x80;
			const der = p1363ToDer(sig);
			for (const part of readDer(der).children) readInteger(part);
			expect(hex(derToP1363(der))).toBe(hex(sig));
		}
	});

	test('a signature of odd or no length is a bug', () => {
		expect(() => p1363ToDer(new Uint8Array(63))).toThrow(RangeError);
		expect(() => p1363ToDer(new Uint8Array())).toThrow(RangeError);
	});
});
