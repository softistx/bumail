import { describe, expect, test } from 'bun:test';
import {
	inNetwork,
	ipDots,
	ipText,
	parseClientIp,
	parseIp4,
	parseIp6,
} from './ip';

describe('parseIp4 (RFC 7208 §5.6 ip4-network)', () => {
	test('reads a dotted quad', () => {
		expect([...(parseIp4('192.0.2.255') ?? [])]).toEqual([192, 0, 2, 255]);
	});

	test.each([
		'1.2.3',
		'1.2.3.4.5',
		'01.2.3.4',
		'1.2.3.256',
		'1.2.3.',
		'1.2.3.4 ',
		'1.2.3.x',
		'',
	])('refuses %p', (text) => {
		expect(parseIp4(text)).toBeUndefined();
	});
});

describe('parseIp6 (RFC 4291 §2.2)', () => {
	test.each([
		['::', '::'],
		['::1', '::1'],
		['2001:DB8::CB01', '2001:db8::cb01'],
		['2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
		['1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7:8'],
		['::1.1.1.1', '::101:101'],
		['cafe:babe:8000::', 'cafe:babe:8000::'],
	])('reads %p', (text, written) => {
		const ip = parseIp6(text);
		expect(ip).toBeDefined();
		expect(ipText(ip as Uint8Array)).toBe(written);
	});

	test.each([
		':CAFE::BABE',
		'1::2::3',
		':::',
		'1:2:3:4:5:6:7',
		'1:2:3:4:5:6:7:8:9',
		'12345::',
		'fe80::1%eth0',
		'1::2:',
		'::1.2.3',
	])('refuses %p', (text) => {
		expect(parseIp6(text)).toBeUndefined();
	});
});

describe('the client address', () => {
	test('an IPv4-mapped IPv6 address is IPv4 (§5)', () => {
		expect(parseClientIp('::FFFF:1.2.3.4')?.length).toBe(4);
		expect(parseClientIp('::ffff:102:304')?.length).toBe(4);
		expect(ipText(parseClientIp('::ffff:1.2.3.4') as Uint8Array)).toBe(
			'1.2.3.4',
		);
		expect(parseClientIp('::1')?.length).toBe(16);
	});

	test('%{i} writes IPv6 as dotted nibbles, %{c} in RFC 5952 form', () => {
		const ip = parseClientIp('2001:DB8::CB01') as Uint8Array;
		expect(ipDots(ip)).toBe(
			'2.0.0.1.0.d.b.8.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.0.c.b.0.1',
		);
		expect(ipText(ip)).toBe('2001:db8::cb01');
		expect(ipText(parseIp6('1:0:0:2:0:0:0:3') as Uint8Array)).toBe(
			'1:0:0:2::3',
		);
		expect(ipText(parseIp6('1:0:2:3:4:5:6:7') as Uint8Array)).toBe(
			'1:0:2:3:4:5:6:7',
		);
	});
});

describe('inNetwork', () => {
	const ip = parseIp4('192.0.2.130') as Uint8Array;

	test('compares the prefix bit by bit', () => {
		const network = parseIp4('192.0.2.128') as Uint8Array;
		expect(inNetwork(ip, network, 30)).toBe(true);
		expect(inNetwork(ip, network, 31)).toBe(false);
		expect(inNetwork(ip, parseIp4('1.1.1.1') as Uint8Array, 0)).toBe(true);
		expect(inNetwork(ip, ip, 32)).toBe(true);
	});

	test('never matches across families', () => {
		expect(inNetwork(ip, parseIp6('::') as Uint8Array, 0)).toBe(false);
	});

	test('reads an IPv6 prefix past a byte boundary', () => {
		const network = parseIp6('cafe:babe:8000::') as Uint8Array;
		expect(
			inNetwork(parseIp6('cafe:babe:8000::1') as Uint8Array, network, 33),
		).toBe(true);
		expect(
			inNetwork(parseIp6('cafe:babe:4000::') as Uint8Array, network, 33),
		).toBe(false);
	});
});
