import { describe, expect, test } from 'bun:test';
import { clientKey } from './client-key';

describe('clientKey', () => {
	test.each([
		['192.0.2.1', '192.0.2.1'],
		['::ffff:192.0.2.1', '192.0.2.1'],
		['::FFFF:192.0.2.1', '192.0.2.1'],
		['::ffff:c000:201', '192.0.2.1'],
		['64:ff9b::c633:6401', '198.51.100.1'],
		['64:ff9b::198.51.100.1', '198.51.100.1'],
		['64:ff9b::c633:6402', '198.51.100.2'],
		['2001:db8:1:2:3:4:5:6', '2001:db8:1:2::/64'],
		['2001:db8:1:2::9', '2001:db8:1:2::/64'],
		['2001:0db8:0001:0002:ffff::1', '2001:db8:1:2::/64'],
		['2001:db8:1:3::9', '2001:db8:1:3::/64'],
		['2001:db8::1', '2001:db8:0:0::/64'],
		['::1', '0:0:0:0::/64'],
		['[2001:db8:1:2::9]', '2001:db8:1:2::/64'],
		['fe80::1%en0', 'fe80:0:0:0::/64'],
		['', undefined],
		['/run/bumail.sock', undefined],
		['not an address', undefined],
	])('%p counts as %p', (ip, key) => {
		expect(clientKey(ip)).toBe(key);
	});

	test('two addresses of one /64 are one client, of two /64s two', () => {
		expect(clientKey('2001:db8:1:2::1')).toBe(
			clientKey('2001:db8:1:2:ffff::2'),
		);
		expect(clientKey('2001:db8:1:2::1')).not.toBe(clientKey('2001:db8:1:3::1'));
	});

	test('an IPv4 client is one client however it is written', () => {
		const key = clientKey('203.0.113.7');
		expect(clientKey('::ffff:203.0.113.7')).toBe(key);
		expect(clientKey('::ffff:cb00:7107')).toBe(key);
		expect(clientKey('64:ff9b::cb00:7107')).toBe(key);
	});

	test('is undefined for no string at all', () => {
		expect(clientKey(undefined)).toBeUndefined();
		expect(clientKey(42 as unknown as string)).toBeUndefined();
	});
});
