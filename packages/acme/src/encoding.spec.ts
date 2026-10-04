import { describe, expect, test } from 'bun:test';
import { pem, pemBytes, shown } from './encoding';

describe('pemBytes', () => {
	test('reads the block written by pem, with any white space in it', () => {
		const bytes = crypto.getRandomValues(new Uint8Array(200));
		const text = pem('PRIVATE KEY', bytes).replaceAll('\n', '\r\n  ');
		expect(pemBytes(`junk\n${text}junk`, 'PRIVATE KEY')).toEqual(bytes);
	});

	test('refuses what is not strict base64, or no block', () => {
		expect(
			pemBytes(
				'-----BEGIN PRIVATE KEY-----\nab!c\n-----END PRIVATE KEY-----',
				'PRIVATE KEY',
			),
		).toBeUndefined();
		expect(
			pemBytes(
				'-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----',
				'PRIVATE KEY',
			),
		).toBeUndefined();
		expect(
			pemBytes(
				'-----BEGIN PRIVATE KEY-----\n\n-----END PRIVATE KEY-----',
				'PRIVATE KEY',
			),
		).toBeUndefined();
		expect(pemBytes('nothing', 'PRIVATE KEY')).toBeUndefined();
	});

	test('64 KiB of white space and no END line take linear time', () => {
		for (const filler of [' ', '\n', 'A', 'A ']) {
			const text = `-----BEGIN PRIVATE KEY-----${filler.repeat(65_536 / filler.length)}`;
			const started = performance.now();
			expect(pemBytes(text, 'PRIVATE KEY')).toBeUndefined();
			expect(performance.now() - started).toBeLessThan(100);
		}
	});
});

describe('shown', () => {
	test('a string quoted and cut, anything else by its kind', () => {
		expect(shown('abc')).toBe('"abc"');
		expect(shown('a'.repeat(81))).toBe(`"${'a'.repeat(80)}…"`);
		expect(shown(1n)).toBe('bigint');
		expect(shown(null)).toBe('null');
		expect(shown([])).toBe('an array');
		const looped: Record<string, unknown> = {};
		looped['self'] = looped;
		expect(shown(looped)).toBe('object');
		expect(shown(undefined)).toBe('undefined');
		const { proxy, revoke } = Proxy.revocable({}, {});
		revoke();
		expect(shown(proxy)).toBe('object');
	});
});
