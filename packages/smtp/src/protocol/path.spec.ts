import { describe, expect, test } from 'bun:test';
import { parsePath } from './path';

describe('parsePath (RFC 5321 §4.1.2)', () => {
	test('the addresses of Appendix D.1', () => {
		expect(parsePath('<Smith@bar.com>', true)).toEqual({
			address: 'Smith@bar.com',
			local: 'Smith',
			domain: 'bar.com',
		});
		expect(parsePath('<Jones@foo.com>', false)?.address).toBe('Jones@foo.com');
	});

	test('the domain is lower-cased; the local part is kept as sent (§2.4)', () => {
		expect(parsePath('<Joe.Bloggs@EXAMPLE.Org>', false)?.address).toBe(
			'Joe.Bloggs@example.org',
		);
	});

	test('the source route of Appendix C is dropped', () => {
		expect(
			parsePath('<@hosta.int,@jkl.org:userc@d.bar.org>', false)?.address,
		).toBe('userc@d.bar.org');
		expect(
			parsePath('<@[192.0.2.1],@[IPv6:2001:db8::1]:u@d.bar.org>', false)
				?.address,
		).toBe('u@d.bar.org');
	});

	test('a source route is taken only as @domain(,@domain)*: (§4.1.2 A-d-l)', () => {
		for (const text of [
			'<@x\r\nRSET\r\nNOOP:a@c.com>',
			'<@x\x00:a@c.com>',
			'<@x>:a@c.com>',
			'<@:a@c.com>',
			'<@a..b:x@c.com>',
			'<@-a.b:x@c.com>',
			'<@a b:x@c.com>',
			'<@a,:x@c.com>',
			'<@a,b:x@c.com>',
			'<@a;@b:x@c.com>',
			'<@a@b:x@c.com>',
			'<@[1.2.3]:x@c.com>',
			'<@a:>',
			'<@a:@b>',
			'<@a:@b:x@c.com>',
			`<@${'a'.repeat(64)}.com:x@c.com>`,
		]) {
			expect(parsePath(text, true)).toBeUndefined();
		}
	});

	test("with 'refuse', a source route is not a path (§4.1.1.3: clients should not send one)", () => {
		expect(parsePath('<@a,@b:x@c.com>', false, 'refuse')).toBeUndefined();
		expect(parsePath('<@a:x@c.com>', false, 'refuse')).toBeUndefined();
		expect(parsePath('<x@c.com>', false, 'refuse')?.address).toBe('x@c.com');
		expect(parsePath('<>', true, 'refuse')?.address).toBe('');
	});

	test('a quoted local part (§4.1.2 Quoted-string)', () => {
		expect(parsePath('<"john doe"@example.com>', false)?.local).toBe(
			'"john doe"',
		);
	});

	test('address literals (§4.1.3)', () => {
		expect(parsePath('<postmaster@[192.0.2.1]>', false)?.domain).toBe(
			'[192.0.2.1]',
		);
		expect(parsePath('<postmaster@[IPv6:2001:db8::1]>', false)?.domain).toBe(
			'[ipv6:2001:db8::1]',
		);
	});

	test('the null reverse-path <> only where allowed (§4.5.5)', () => {
		expect(parsePath('<>', true)).toEqual({
			address: '',
			local: '',
			domain: '',
		});
		expect(parsePath('<>', false)).toBeUndefined();
	});

	test('a non-ASCII address parses; SMTPUTF8 decides whether it is taken (RFC 6531)', () => {
		expect(parsePath('<用户@例子.广告>', false)?.domain).toBe('例子.广告');
	});

	test('what is not a path', () => {
		for (const text of [
			'Smith@bar.com',
			'<Smith>',
			'<@bar.com>',
			'<a b@c.d>',
			'<a@b..c>',
			'<a@-b.c>',
			'<a,b@c.d>',
			`<${'x'.repeat(65)}@c.d>`,
			'<"unterminated@c.d>',
		]) {
			expect(parsePath(text, true)).toBeUndefined();
		}
	});

	test('C1 controls, format characters and line separators are refused, even under SMTPUTF8', () => {
		for (const char of [
			'\u0085',
			'\u009b',
			'\u2028',
			'\u2029',
			'\u200b',
			'\u202e',
			'\ufeff',
		]) {
			expect(parsePath(`<a${char}b@foo.com>`, false)).toBeUndefined();
			expect(parsePath(`<"a${char}b"@foo.com>`, false)).toBeUndefined();
			expect(parsePath(`<ab@fo${char}o.com>`, false)).toBeUndefined();
		}
	});

	test('a lone surrogate is refused, quoted or not, whatever is done with a source route', () => {
		for (const route of ['discard', 'refuse'] as const) {
			for (const char of ['\uD800', '\uDFFF']) {
				expect(parsePath(`<a${char}@c.com>`, false, route)).toBeUndefined();
				expect(parsePath(`<"a${char}"@c.com>`, false, route)).toBeUndefined();
				expect(parsePath(`<a@c${char}.com>`, false, route)).toBeUndefined();
			}
			// A pair is one character, and an address may hold it.
			expect(parsePath('<a\u{1F600}@c.com>', false, route)?.local).toBe(
				'a\u{1F600}',
			);
		}
	});

	test('an IPv4 address literal takes octets up to 255 (§4.1.3)', () => {
		expect(parsePath('<a@[255.255.255.255]>', false)?.domain).toBe(
			'[255.255.255.255]',
		);
		for (const literal of ['[999.1.1.1]', '[1.256.1.1]', '[1.1.1.300]']) {
			expect(parsePath(`<a@${literal}>`, false)).toBeUndefined();
		}
	});

	test('a quoted @ or a % stays in the local part, of the domain after the last @', () => {
		expect(parsePath('<"v@evil.example"@foo.com>', false)).toEqual({
			address: '"v@evil.example"@foo.com',
			local: '"v@evil.example"',
			domain: 'foo.com',
		});
		expect(parsePath('<v%evil.example@foo.com>', false)?.domain).toBe(
			'foo.com',
		);
	});

	test('CR, LF, NUL, other C0 controls, DEL and > are refused in every part', () => {
		const shapes = [
			(c: string) => `<${c}a@foo.com>`,
			(c: string) => `<a${c}@foo.com>`,
			(c: string) => `<a.b${c}c@foo.com>`,
			(c: string) => `<"a${c}b"@foo.com>`,
			(c: string) => `<"a\\${c}b"@foo.com>`,
			(c: string) => `<a@${c}foo.com>`,
			(c: string) => `<a@fo${c}o.com>`,
			(c: string) => `<a@foo.com${c}>`,
			(c: string) => `<a@[192.0.2.1${c}]>`,
			(c: string) => `<${c}@a:x@foo.com>`,
			(c: string) => `<@${c}a:x@foo.com>`,
			(c: string) => `<@a${c}:x@foo.com>`,
			(c: string) => `<@a,${c}@b:x@foo.com>`,
			(c: string) => `<@a,@b${c}:x@foo.com>`,
			(c: string) => `<@a,@b:${c}x@foo.com>`,
			(c: string) => `<@a,@b:x@foo.com${c}>`,
			(c: string) => `<@[192.0.2.1${c}]:x@foo.com>`,
		];
		const chars = ['\r', '\n', '\r\n', '\x00', '>', '\t', '\x1b', '\x7f'];
		for (const shape of shapes) {
			for (const char of chars) {
				const text = shape(char);
				for (const route of ['discard', 'refuse'] as const) {
					expect([text, parsePath(text, true, route)]).toEqual([
						text,
						undefined,
					]);
				}
			}
		}
		// Each shape, without the character, is a path: what refuses it is the character.
		for (const shape of shapes) {
			expect([shape(''), parsePath(shape(''), true)?.address]).toEqual([
				shape(''),
				expect.any(String),
			]);
		}
	});
});
