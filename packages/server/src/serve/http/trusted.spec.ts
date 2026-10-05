import { describe, expect, test } from 'bun:test';
import { canonical } from '../../proxy/canonical';
import { trustsOf } from './trusted';

const trusts = trustsOf(['10.0.0.0/8', '192.168.1.5', '2001:db8:1::/48']);

describe('trustsOf', () => {
	test('matches addresses and CIDRs of both families', () => {
		expect(trusts('10.2.3.4')).toBe(true);
		expect(trusts('192.168.1.5')).toBe(true);
		expect(trusts('192.168.1.6')).toBe(false);
		expect(trusts('2001:db8:1::9')).toBe(true);
		expect(trusts('2001:db8:2::9')).toBe(false);
	});

	test('takes an IPv4-mapped peer as its IPv4 address, and nothing that is no address', () => {
		expect(trusts('::ffff:10.2.3.4')).toBe(true);
		expect(trusts('::ffff:11.2.3.4')).toBe(false);
		expect(trusts('fe80::1%eth0')).toBe(false);
		expect(trusts('')).toBe(false);
		expect(trusts('localhost')).toBe(false);
	});

	test('takes a mapped entry as its IPv4 address', () => {
		expect(trustsOf(['::ffff:10.0.0.5'])('10.0.0.5')).toBe(true);
	});
});

describe('trustsOf never crosses families', () => {
	test('an IPv6 network, however wide, trusts no IPv4 peer, mapped or not', () => {
		for (const entry of ['::/1', '::/8', '::/80']) {
			const some = trustsOf([entry]);
			expect(some('8.8.8.8')).toBe(false);
			expect(some('::ffff:8.8.8.8')).toBe(false);
		}
		expect(trustsOf(['::/8'])('8.8.8.8')).toBe(false);
	});
});

describe('canonical', () => {
	test('is RFC 5952 form, IPv4-mapped as IPv4, nothing for a zone or a non-address', () => {
		expect(canonical('::ffff:203.0.113.7')).toBe('203.0.113.7');
		expect(canonical('2001:0DB8:0:0:0:0:0:1')).toBe('2001:db8::1');
		expect(canonical('fe80::1%eth0')).toBeUndefined();
		expect(canonical('proxy')).toBeUndefined();
	});
});
