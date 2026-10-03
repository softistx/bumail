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
});
