import { describe, expect, test } from 'bun:test';
import { formatAddress } from './address';
import { trustedPeers } from './trusted';

const invalid = (message: string) => new Error(message);
const trust = (entries: unknown) => trustedPeers(entries, invalid);

describe('trustedPeers', () => {
	test('addresses and CIDRs, IPv4 and IPv6', () => {
		const trusts = trust(['192.0.2.10', '10.0.0.0/8', '2001:db8:1::/48']);
		expect(trusts('192.0.2.10')).toBe(true);
		expect(trusts('192.0.2.11')).toBe(false);
		expect(trusts('10.255.0.1')).toBe(true);
		expect(trusts('11.0.0.1')).toBe(false);
		expect(trusts('2001:db8:1:ffff::5')).toBe(true);
		expect(trusts('2001:db8:2::5')).toBe(false);
	});

	test('a prefix that is not a whole number of bytes', () => {
		const trusts = trust(['172.16.0.0/12']);
		expect(trusts('172.31.255.255')).toBe(true);
		expect(trusts('172.32.0.0')).toBe(false);
		expect(trusts('172.15.255.255')).toBe(false);
	});

	test('an IPv4-mapped peer is its IPv4 address, as a dual-stack listener reports it', () => {
		const trusts = trust(['10.0.0.0/8']);
		expect(trusts('::ffff:10.1.2.3')).toBe(true);
		expect(trusts('::ffff:a01:203')).toBe(true);
		expect(trust(['::ffff:10.0.0.0/104'])('10.9.9.9')).toBe(true);
	});

	test('IPv4 never matches an IPv6 network, nor the other way', () => {
		expect(trust(['::/0'])('10.0.0.1')).toBe(false);
		expect(trust(['0.0.0.0/0'])('::1')).toBe(false);
	});

	test('a zone, or anything that is not an address, never matches', () => {
		expect(trust(['fe80::/10'])('fe80::1%en0')).toBe(true);
		expect(trust(['10.0.0.0/8'])('')).toBe(false);
		expect(trust(['10.0.0.0/8'])('/tmp/smtp.sock')).toBe(false);
	});

	test.each([
		[undefined],
		[[]],
		['10.0.0.1'],
		[['10.0.0.1/33']],
		[['::/129']],
		[['10.0.0.0/-1']],
		[['10.0.0.0/8/8']],
		[['proxy.internal']],
		[['10.0.0.0/']],
		[[10]],
		[['::ffff:10.0.0.0/8']],
	])('refuses %p', (entries) => {
		expect(() => trust(entries)).toThrow(/proxyProtocol\.trusted/);
	});
});

describe('formatAddress', () => {
	const bytes = (...groups: number[]) => {
		const out = new Uint8Array(16);
		const view = new DataView(out.buffer);
		groups.forEach((group, at) => {
			view.setUint16(at * 2, group);
		});
		return out;
	};

	test('RFC 5952 §4: the longest zero run as ::, the first of equal ones, never one group', () => {
		expect(formatAddress(bytes(0x2001, 0xdb8, 0, 0, 1, 0, 0, 1))).toBe(
			'2001:db8::1:0:0:1',
		);
		expect(formatAddress(bytes(0x2001, 0xdb8, 0, 1, 1, 1, 1, 1))).toBe(
			'2001:db8:0:1:1:1:1:1',
		);
		expect(formatAddress(bytes(0x2001, 0, 0, 1, 0, 0, 0, 1))).toBe(
			'2001:0:0:1::1',
		);
		expect(formatAddress(bytes())).toBe('::');
		expect(formatAddress(bytes(0, 0, 0, 0, 0, 0, 0, 1))).toBe('::1');
		expect(formatAddress(bytes(1))).toBe('1::');
	});

	test('IPv4, and IPv4-mapped as IPv4', () => {
		expect(formatAddress(new Uint8Array([192, 0, 2, 1]))).toBe('192.0.2.1');
		expect(formatAddress(bytes(0, 0, 0, 0, 0, 0xffff, 0xc000, 0x0201))).toBe(
			'192.0.2.1',
		);
	});
});
