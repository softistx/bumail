import { describe, expect, test } from 'bun:test';
import type { DkimResult } from '../dkim/result';
import { dkim, spf } from '../dmarc/dmarc.fixtures';
import type { DmarcResult } from '../dmarc/result';
import { AuthError } from '../errors';
import {
	formatAuthenticationResults,
	writtenValue,
} from './authentication-results';

/** The field unfolded (RFC 5322 §2.2.3), without its final CRLF. */
function unfold(field: string): string {
	expect(field.endsWith('\r\n')).toBe(true);
	return field.slice(0, -2).replace(/\r\n(?=[ \t])/g, '');
}

/** The field as RFC 8601 prints it, its blanks collapsed. */
function printed(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

const dmarc = (result: DmarcResult['result'], domain: string): DmarcResult => ({
	result,
	reason: 'spec',
	domain,
	policy: 'none',
	disposition: 'none',
	sampled: true,
});

describe("RFC 8601 Appendix B's examples", () => {
	test('B.2: service provided, no authentication done', () => {
		// The RFC writes `example.org 1; none`; the version is optional, and 1 is assumed.
		expect(unfold(formatAuthenticationResults('example.org', {}))).toBe(
			'Authentication-Results: example.org; none',
		);
	});

	test('B.3: service provided, authentication done', () => {
		expect(
			unfold(
				formatAuthenticationResults('example.com', { spf: spf('example.net') }),
			),
		).toBe(
			printed(`Authentication-Results: example.com;
                  spf=pass smtp.mailfrom=example.net`),
		);
	});

	test('B.5: dkim=pass header.d=example.com, then the selector and the start of b=', () => {
		const signature: DkimResult = {
			result: 'pass',
			domain: 'example.com',
			selector: 'gatsby',
			signature: 'EToRSuvUfQVP3Bkz',
			testing: false,
		};
		expect(
			unfold(formatAuthenticationResults('example.com', { dkim: [signature] })),
		).toBe(
			'Authentication-Results: example.com; dkim=pass header.d=example.com header.s=gatsby header.b=EToRSuvU',
		);
	});

	test('B.5: spf=fail smtp.mailfrom=example.com', () => {
		expect(
			unfold(
				formatAuthenticationResults('example.com', {
					spf: spf('example.com', 'fail'),
				}),
			),
		).toBe(
			'Authentication-Results: example.com; spf=fail smtp.mailfrom=example.com',
		);
	});
});

describe('formatAuthenticationResults', () => {
	test('DKIM, SPF and DMARC in one field, folded at 78 columns', () => {
		const field = formatAuthenticationResults('mx.example.org', {
			dkim: [dkim('example.com'), dkim('lists.example.net', 'fail')],
			spf: spf('mail.example.com', 'softfail', 'helo'),
			dmarc: dmarc('pass', 'example.com'),
		});
		for (const line of field.slice(0, -2).split('\r\n')) {
			expect(line.length).toBeLessThanOrEqual(78);
		}
		expect(unfold(field)).toBe(
			'Authentication-Results: mx.example.org;' +
				' dkim=pass header.d=example.com header.s=sel header.b="abc/+=";' +
				' dkim=fail header.d=lists.example.net header.s=sel header.b="abc/+=";' +
				' spf=softfail smtp.helo=mail.example.com;' +
				' dmarc=pass header.from=example.com',
		);
	});

	test('a result with nothing to name has no property', () => {
		const field = formatAuthenticationResults('mx.example.org', {
			dkim: [
				{ result: 'none', reason: 'no DKIM-Signature header', testing: false },
			],
			dmarc: dmarc('permerror', ''),
		});
		expect(unfold(field)).toBe(
			'Authentication-Results: mx.example.org; dkim=none; dmarc=permerror',
		);
	});

	test('a value that is not a token is quoted (§2.2)', () => {
		expect(writtenValue('example.com')).toBe('example.com');
		expect(writtenValue('abc/+=')).toBe('"abc/+="');
		expect(writtenValue('[192.0.2.1]')).toBe('"[192.0.2.1]"');
		expect(writtenValue('a "b" \\c')).toBe('"a \\"b\\" \\\\c"');
		expect(writtenValue('bücher.example')).toBe('"bücher.example"');
		expect(writtenValue('')).toBeUndefined();
		for (const char of [
			'\u0085',
			'\u009f',
			'\u2028',
			'\u2029',
			'\ud800',
			'\udc00',
		]) {
			expect(writtenValue(`a${char}b`)).toBeUndefined();
		}
		expect(writtenValue('a😀b')).toBe('"a😀b"');
		expect(writtenValue('x'.repeat(256))).toBeUndefined();
	});
});

describe('no value can end a result or add a line', () => {
	test('a ; in a value stays inside quotes', () => {
		const field = formatAuthenticationResults('mx.example.org', {
			spf: spf('evil.example; dkim=pass header.d=bank.example', 'none'),
		});
		expect(unfold(field)).toBe(
			'Authentication-Results: mx.example.org; spf=none smtp.mailfrom="evil.example; dkim=pass header.d=bank.example"',
		);
	});

	test('a CR or LF in a value leaves that property out', () => {
		const field = formatAuthenticationResults('mx.example.org', {
			dkim: [{ ...dkim('evil.example\r\nX-Injected: yes'), selector: 's\n' }],
			spf: spf('evil.example\rdmarc=pass', 'none'),
			dmarc: dmarc('fail', 'example.com\u0000'),
		});
		expect(
			field
				.slice(0, -2)
				.split('\r\n')
				.slice(1)
				.every((l) => /^[ \t]/.test(l)),
		).toBe(true);
		expect(field).not.toContain('X-Injected');
		expect(unfold(field)).toBe(
			'Authentication-Results: mx.example.org; dkim=pass header.b="abc/+="; spf=none; dmarc=fail',
		);
	});

	test('a hostile authserv-id or result word is refused', () => {
		const call = (id: string, results: object) => () =>
			formatAuthenticationResults(id, results as never);
		expect(call('mx.example.org\r\nX: y', {})).toThrow(AuthError);
		expect(call('', {})).toThrow(
			'formatAuthenticationResults(): authservId must be 1 to 255 characters with no control character, such as the host name',
		);
		expect(call('mx', { dkim: [{ result: 'pass; spf=pass' }] })).toThrow(
			'formatAuthenticationResults(): dkim result "pass; spf=pass" is not one of pass|fail|neutral|temperror|permerror|policy|none',
		);
		expect(call('mx', { spf: { identity: 'mailfrom' } })).toThrow(
			'formatAuthenticationResults(): spf result undefined is not one of none|neutral|pass|fail|softfail|temperror|permerror',
		);
		expect(call('mx', { dmarc: { result: 'reject' } })).toThrow(
			'formatAuthenticationResults(): dmarc result "reject" is not one of pass|fail|none|temperror|permerror',
		);
		expect(call('mx', { spf: null })).toThrow(AuthError);
		expect(
			unfold(
				formatAuthenticationResults('mx', {
					dkim: [{ result: 'pass', domain: 5 } as never],
				}),
			),
		).toBe('Authentication-Results: mx; dkim=pass');
		expect(call('mx', { dmarc: null })).toThrow(AuthError);
		expect(call('mx', { dkim: [null] })).toThrow(AuthError);
		expect(call('mx', { dkim: {} })).toThrow(
			'formatAuthenticationResults(): dkim must be the array verifyDkim returned',
		);
		expect(call('mx', null as never)).toThrow(
			'formatAuthenticationResults(): results must be an object of dkim, spf and dmarc',
		);
	});

	test('a quoted authserv-id', () => {
		expect(unfold(formatAuthenticationResults('mx (main)', {}))).toBe(
			'Authentication-Results: "mx (main)"; none',
		);
	});

	test('a thousand signatures fold, every line within 998', () => {
		const field = formatAuthenticationResults('mx.example.org', {
			dkim: Array.from({ length: 1000 }, (_, i) => dkim(`d${i}.example`)),
		});
		const lines = field.slice(0, -2).split('\r\n');
		expect(lines.length).toBeGreaterThan(100);
		expect(lines.every((line) => line.length <= 998)).toBe(true);
	});
});
