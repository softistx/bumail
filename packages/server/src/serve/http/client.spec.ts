import { describe, expect, test } from 'bun:test';
import { canonical } from '../../proxy/canonical';
import { forwardedClient } from './client';
import { trustsOf } from './trusted';

const trusts = trustsOf(['10.0.0.0/8', '192.168.1.5', '2001:db8:1::/48']);

function headers(forwardedFor?: string, proto?: string): Headers {
	const result = new Headers();
	if (forwardedFor !== undefined) result.set('x-forwarded-for', forwardedFor);
	if (proto !== undefined) result.set('x-forwarded-proto', proto);
	return result;
}

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

describe('forwardedClient', () => {
	test('counts a client under one text: a mapped or upper-case entry is normalised', () => {
		expect(
			forwardedClient('10.0.0.1', headers('::ffff:203.0.113.7'), trusts).ip,
		).toBe('203.0.113.7');
		expect(
			forwardedClient('::ffff:10.0.0.1', headers('2001:DB8:9:0::1'), trusts).ip,
		).toBe('2001:db8:9::1');
	});

	test('takes the right-most entry that is not a trusted proxy', () => {
		const client = forwardedClient(
			'10.0.0.1',
			headers('1.1.1.1, 203.0.113.7, 10.0.0.2', 'https'),
			trusts,
		);
		expect(client).toEqual({ ip: '203.0.113.7', secure: true });
	});

	test('does not read past the first entry that is not a proxy: a spoofed left side', () => {
		const client = forwardedClient(
			'10.0.0.1',
			headers('10.0.0.9, 198.51.100.1, 203.0.113.7'),
			trusts,
		);
		expect(client.ip).toBe('203.0.113.7');
	});

	test('reads several header lines as one chain, and brackets and ports', () => {
		const list = new Headers();
		list.append('x-forwarded-for', '198.51.100.1');
		list.append('x-forwarded-for', '[2001:db8:9::1]:4000');
		expect(forwardedClient('10.0.0.1', list, trusts).ip).toBe('2001:db8:9::1');
		expect(
			forwardedClient('10.0.0.1', headers('203.0.113.7:5555'), trusts).ip,
		).toBe('203.0.113.7');
	});

	test('answers the peer for no header, only proxies, or an entry that is no address', () => {
		for (const chain of [undefined, '', '10.0.0.2, 192.168.1.5', 'unknown']) {
			expect(forwardedClient('10.0.0.1', headers(chain), trusts).ip).toBe(
				'10.0.0.1',
			);
		}
	});

	test('ignores both headers from a peer that is not trusted', () => {
		expect(
			forwardedClient('198.51.100.20', headers('203.0.113.7', 'https'), trusts),
		).toEqual({ ip: '198.51.100.20', secure: false });
	});

	test('is secure only when the last proxy says https', () => {
		const secure = (proto?: string) =>
			forwardedClient('10.0.0.1', headers('203.0.113.7', proto), trusts).secure;
		expect(secure('https')).toBe(true);
		expect(secure('HTTPS')).toBe(true);
		expect(secure('http, https')).toBe(true);
		expect(secure('https, http')).toBe(false);
		expect(secure('http')).toBe(false);
		expect(secure()).toBe(false);
	});
});
