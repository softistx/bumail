import { describe, expect, test } from 'bun:test';
import { Slots } from './slots';

describe('Slots', () => {
	test('counts each client, and frees a slot once however often it is released', () => {
		const slots = new Slots<object>();
		const a = {};
		const b = {};
		const c = {};
		slots.take(a, '192.0.2.1');
		slots.take(b, '192.0.2.1');
		slots.take(c, undefined);
		expect(slots.size).toBe(3);
		expect(slots.of('192.0.2.1')).toBe(2);
		expect(slots.of(undefined)).toBe(0);
		slots.release(a);
		slots.release(a);
		expect(slots.of('192.0.2.1')).toBe(1);
		expect(slots.size).toBe(2);
		slots.release(b);
		slots.release(c);
		expect(slots.of('192.0.2.1')).toBe(0);
		expect(slots.size).toBe(0);
		expect(slots.connections()).toEqual([]);
	});
});
