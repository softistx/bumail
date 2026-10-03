import { describe, expect, test } from 'bun:test';
import { DnsError } from './errors';
import { normalizeAddress, normalizeName } from './name';

function refused(run: () => unknown): DnsError {
	try {
		run();
	} catch (error) {
		if (error instanceof DnsError) return error;
		throw error;
	}
	throw new Error('expected INVALID_NAME');
}

describe('normalizeName', () => {
	test('lowercases and drops the trailing dot', () => {
		expect(normalizeName('Example.COM.')).toBe('example.com');
	});

	test('keeps the underscore labels of DMARC and DKIM', () => {
		expect(normalizeName('_dmarc.example.com')).toBe('_dmarc.example.com');
		expect(normalizeName('s1._domainkey.Example.com')).toBe(
			's1._domainkey.example.com',
		);
	});

	test('turns an IDN into its A-labels', () => {
		expect(normalizeName('bücher.example')).toBe('xn--bcher-kva.example');
		expect(normalizeName('münchen.DE.')).toBe('xn--mnchen-3ya.de');
	});

	test('keeps case folding, composed accents and ß, which name the same domain', () => {
		expect(normalizeName('Bücher.example')).toBe('xn--bcher-kva.example');
		expect(normalizeName('e\u0301xample.com')).toBe('xn--xample-9ua.com');
		expect(normalizeName('straße.de')).toBe('xn--strae-oqa.de');
		expect(normalizeName('_dmarc.bücher.example')).toBe(
			'_dmarc.xn--bcher-kva.example',
		);
	});

	test('takes a label of 63 characters and a name of 253, no more', () => {
		const label = 'a'.repeat(63);
		expect(normalizeName(`${label}.example`)).toBe(`${label}.example`);
		expect(refused(() => normalizeName(`${label}a.example`)).code).toBe(
			'INVALID_NAME',
		);
		const long = Array.from({ length: 4 }, () => 'b'.repeat(62)).join('.');
		expect(long.length).toBe(251);
		expect(normalizeName(`${long}.c`)).toBe(`${long}.c`);
		expect(refused(() => normalizeName(`${long}.cd`)).message).toContain('253');
	});

	test('refuses what is not a host name, before any query', () => {
		for (const name of [
			'',
			'.',
			'a..b',
			'.example.com',
			'exa mple.com',
			'example.com\r\nX',
			'example.com\0',
			'-bad.example',
			'bad-.example',
			'ex*ample.com',
			'ex/ample.com',
			'192.0.2.1',
			'2001:db8::1',
		]) {
			const error = refused(() => normalizeName(name));
			expect(error.code).toBe('INVALID_NAME');
		}
		expect(refused(() => normalizeName(42)).message).toBe(
			'A name to look up is a string, not number',
		);
	});

	test('names what it refused, with the reason', () => {
		expect(refused(() => normalizeName('a..b')).message).toBe(
			'"a..b" is not a name to look up: it has an empty label',
		);
		expect(refused(() => normalizeName('192.0.2.1')).message).toBe(
			'"192.0.2.1" is not a name to look up: it is an address; look its name up with ptr()',
		);
		expect(refused(() => normalizeName('2001:db8::1')).message).toContain(
			'it is an address',
		);
	});

	test('never swaps a name holding URL syntax for another one', () => {
		for (const [name, why] of [
			['évil@good.example', 'it holds "@", which no host name has'],
			['bücher.example/path', 'it holds "/", which no host name has'],
			['bücher.example:25', 'it holds ":", which no host name has'],
			['bücher.example?x', 'it holds "?", which no host name has'],
			['bücher.example#frag', 'it holds "#", which no host name has'],
			['bü\\x.example', 'it holds "\\\\", which no host name has'],
			['ex%41.bü', 'it holds "%", which no host name has'],
			[
				'x\u00ady.example',
				'it holds an invisible character the IDN mapping would drop',
			],
			[
				'bü\u200dx.example',
				'it holds an invisible character the IDN mapping would drop',
			],
			['b\u3002ü.example', 'its IDN mapping changes its labels'],
		] as const) {
			const error = refused(() => normalizeName(name));
			expect(error.code).toBe('INVALID_NAME');
			expect(error.message).toBe(
				`${JSON.stringify(name)} is not a name to look up: ${why}`,
			);
		}
	});

	test('never lets the IDN mapping turn a name into another one', () => {
		const why =
			'its IDN mapping turns it into another name; write that name instead';
		for (const name of [
			'ｅｘａｍｐｌｅ.com',
			'𝐠𝐨𝐨𝐠𝐥𝐞.com',
			'ⓖoogle.com',
			'ſtripe.com',
			'ﬀ.com',
			'ｘｎ－－ｂｃｈｅｒ－ｋｖａ.com',
			'ⅹn--bcher-kva.com',
			'_dmarc.ｅｘａｍｐｌｅ.com',
			'\u212Aelvin.example',
		]) {
			const error = refused(() => normalizeName(name));
			expect(error.code).toBe('INVALID_NAME');
			expect(error.message).toBe(
				`${JSON.stringify(name)} is not a name to look up: ${why}`,
			);
		}
	});
});

describe('normalizeAddress', () => {
	test('takes IPv4 as written and IPv6 in its canonical form', () => {
		expect(normalizeAddress('192.0.2.1')).toBe('192.0.2.1');
		expect(normalizeAddress('2001:DB8::1')).toBe('2001:db8::1');
		expect(normalizeAddress('2001:0DB8:0:0::1')).toBe('2001:db8::1');
		expect(normalizeAddress('2001:db8:0:0:0:0:0:1')).toBe('2001:db8::1');
	});

	test('folds an IPv4-mapped IPv6 address to IPv4, in any spelling', () => {
		for (const mapped of [
			'::ffff:192.0.2.1',
			'::FFFF:C000:0201',
			'0:0:0:0:0:ffff:192.0.2.1',
		]) {
			expect(normalizeAddress(mapped)).toBe('192.0.2.1');
		}
		expect(normalizeAddress('::192.0.2.1')).toBe('::c000:201');
	});

	test('refuses a zone and anything else', () => {
		for (const value of ['example.com', '999.0.0.1', 'fe80::1%eth0', '', 7]) {
			expect(refused(() => normalizeAddress(value)).code).toBe('INVALID_NAME');
		}
	});
});
