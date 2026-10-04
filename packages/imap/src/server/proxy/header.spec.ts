import { describe, expect, test } from 'bun:test';
import {
	MAX_TLV_BYTES,
	MAX_V1_LENGTH,
	type ProxyHeader,
	readProxyHeader,
} from './header';
import { concat, SIGNATURE, tlv, v1, v2 } from './headers.fixtures';

const text = (line: string) => readProxyHeader(new TextEncoder().encode(line));
const complete = (length: number, source?: string): ProxyHeader =>
	source === undefined
		? { status: 'complete', length }
		: { status: 'complete', length, source };

describe('version 1 (proxy-protocol.txt §2.1)', () => {
	test('TCP4: the source address is the client', () => {
		const line = 'PROXY TCP4 192.168.0.1 192.168.0.11 56324 443\r\n';
		expect(text(line)).toEqual(complete(line.length, '192.168.0.1'));
	});

	test('TCP6, and the worst case lengths §2.1 gives: 104 bytes, and 107 for UNKNOWN', () => {
		const ffff = 'ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff';
		const tcp6 = `PROXY TCP6 ${ffff} ${ffff} 65535 65535\r\n`;
		expect(tcp6.length).toBe(104);
		expect(text(tcp6)).toEqual(complete(104, ffff));
		const unknown = `PROXY UNKNOWN ${ffff} ${ffff} 65535 65535\r\n`;
		expect(unknown.length).toBe(MAX_V1_LENGTH);
		expect(text(unknown)).toEqual(complete(107));
	});

	test('the TCP4 worst case, 56 bytes', () => {
		const line = 'PROXY TCP4 255.255.255.255 255.255.255.255 65535 65535\r\n';
		expect(line.length).toBe(56);
		expect(text(line)).toEqual(complete(56, '255.255.255.255'));
	});

	test('UNKNOWN keeps the peer: no source', () => {
		expect(text('PROXY UNKNOWN\r\n')).toEqual(complete(15));
	});

	test('an IPv6 source is written as RFC 5952 has it, an IPv4-mapped one as IPv4', () => {
		expect(readProxyHeader(v1('2001:DB8:0:0:0:0:0:1'))).toMatchObject({
			source: '2001:db8::1',
		});
		expect(readProxyHeader(v1('::ffff:203.0.113.9'))).toMatchObject({
			source: '203.0.113.9',
		});
	});

	test('what follows the line is not the header', () => {
		const line = 'PROXY TCP4 198.51.100.4 192.0.2.1 1024 25\r\n';
		expect(text(`${line}EHLO x\r\n`)).toEqual(
			complete(line.length, '198.51.100.4'),
		);
	});

	test('partial until the CRLF, within 107 bytes', () => {
		expect(text('P')).toEqual({ status: 'partial' });
		expect(text('PROXY TCP4 198.51.100.4 19')).toEqual({ status: 'partial' });
		expect(text(`PROXY UNKNOWN ${'x'.repeat(93)}`).status).toBe('invalid');
		expect(text(`PROXY UNKNOWN ${'x'.repeat(92)}`).status).toBe('partial');
	});

	test.each([
		[
			'a family that is not TCP4, TCP6 or UNKNOWN',
			'PROXY UDP4 1.2.3.4 1.2.3.5 1 2\r\n',
		],
		['an IPv6 address under TCP4', 'PROXY TCP4 ::1 ::1 1 2\r\n'],
		['an IPv4 address under TCP6', 'PROXY TCP6 1.2.3.4 1.2.3.5 1 2\r\n'],
		['a host name', 'PROXY TCP4 example.com 1.2.3.5 1 2\r\n'],
		['a port past 65535', 'PROXY TCP4 1.2.3.4 1.2.3.5 65536 2\r\n'],
		['a port with a leading zero', 'PROXY TCP4 1.2.3.4 1.2.3.5 025 2\r\n'],
		['a field missing', 'PROXY TCP4 1.2.3.4 1.2.3.5 1\r\n'],
		['two spaces', 'PROXY TCP4  1.2.3.4 1.2.3.5 1 2\r\n'],
		['a bare LF', 'PROXY TCP4 1.2.3.4 1.2.3.5 1 2\n'],
		['a control character', 'PROXY TCP4 1.2.3.4\t1.2.3.5 1 2\r\n'],
		['lower case', 'proxy TCP4 1.2.3.4 1.2.3.5 1 2\r\n'],
		['an SMTP command', 'EHLO client.example\r\n'],
	])('refuses %s', (_, line) => {
		expect(text(line).status).toBe('invalid');
	});
});

describe('version 2 (proxy-protocol.txt §2.2)', () => {
	test('PROXY, AF_INET over STREAM: the source address is the client', () => {
		const header = v2({ source: '198.51.100.7' });
		expect(header.length).toBe(16 + 12);
		expect(readProxyHeader(header)).toEqual(complete(28, '198.51.100.7'));
	});

	test('PROXY, AF_INET6 over STREAM', () => {
		const header = v2({ source: '2001:db8:85a3::8a2e:370:7334' });
		expect(readProxyHeader(header)).toEqual(
			complete(16 + 36, '2001:db8:85a3::8a2e:370:7334'),
		);
		expect(
			readProxyHeader(v2({ source: '::ffff:198.51.100.7', family: 2 })),
		).toMatchObject({ source: '198.51.100.7' });
	});

	test('LOCAL keeps the peer: a health check from the proxy itself', () => {
		expect(readProxyHeader(v2({ command: 0, family: 0 }))).toEqual(
			complete(16),
		);
		// Its address block, whatever it says, is ignored.
		expect(readProxyHeader(v2({ command: 0, source: '198.51.100.7' }))).toEqual(
			complete(28),
		);
	});

	test('UNSPEC, UNIX and datagrams keep the peer', () => {
		expect(readProxyHeader(v2({ family: 0 }))).toEqual(complete(16));
		expect(readProxyHeader(v2({ family: 3 }))).toEqual(complete(16 + 216));
		expect(
			readProxyHeader(v2({ source: '198.51.100.7', transport: 2 })),
		).toEqual(complete(28));
	});

	test('TLVs are skipped, the source kept', () => {
		const tlvs = [
			tlv(0x01, new TextEncoder().encode('smtp')), // PP2_TYPE_ALPN
			tlv(0x04, new Uint8Array(0)), // PP2_TYPE_NOOP
			tlv(0x05, new Uint8Array(128)), // PP2_TYPE_UNIQUE_ID
		];
		const header = v2({ source: '198.51.100.7', tlvs });
		expect(readProxyHeader(header)).toEqual(
			complete(header.length, '198.51.100.7'),
		);
	});

	test('what follows the header is not the header', () => {
		const header = v2({ source: '198.51.100.7' });
		expect(readProxyHeader(concat(header, '\x16\x03\x01'))).toEqual(
			complete(28, '198.51.100.7'),
		);
	});

	test('partial until the length the header gives', () => {
		const header = v2({ source: '198.51.100.7' });
		for (const length of [1, 5, 12, 15, 16, 27]) {
			expect(readProxyHeader(header.subarray(0, length))).toEqual({
				status: 'partial',
			});
		}
	});

	test(`TLVs past ${MAX_TLV_BYTES} bytes are refused, before they arrive`, () => {
		const big = v2({ source: '198.51.100.7', length: 12 + MAX_TLV_BYTES + 1 });
		expect(readProxyHeader(big.subarray(0, 16)).status).toBe('invalid');
		const most = v2({
			source: '198.51.100.7',
			tlvs: [tlv(0xe0, new Uint8Array(MAX_TLV_BYTES - 3))],
		});
		expect(readProxyHeader(most).status).toBe('complete');
	});

	test.each([
		[
			'a TLV running past the header',
			[tlv(1, new Uint8Array(4)).subarray(0, 5)],
		],
		['two bytes of a TLV', [new Uint8Array([1, 0])]],
	])('refuses %s', (_, tlvs) => {
		expect(readProxyHeader(v2({ source: '198.51.100.7', tlvs })).status).toBe(
			'invalid',
		);
	});

	test('refuses a version other than 2, an unknown command, family or transport', () => {
		const header = v2({ source: '198.51.100.7' });
		const with13 = (value: number, at = 12) => {
			const copy = header.slice();
			copy[at] = value;
			return readProxyHeader(copy).status;
		};
		expect(with13(0x11)).toBe('invalid');
		expect(with13(0x22)).toBe('invalid');
		expect(with13(0x41, 13)).toBe('invalid');
		expect(with13(0x13, 13)).toBe('invalid');
	});

	test('refuses an address block shorter than its family', () => {
		expect(
			readProxyHeader(v2({ source: '198.51.100.7', length: 8 })).status,
		).toBe('invalid');
	});

	test('refuses a signature that goes wrong, as soon as it does', () => {
		expect(readProxyHeader(new Uint8Array(SIGNATURE.slice(0, 7))).status).toBe(
			'partial',
		);
		expect(
			readProxyHeader(new Uint8Array([0x0d, 0x0a, 0x0d, 0x0b])).status,
		).toBe('invalid');
		expect(readProxyHeader(new Uint8Array([0x16, 0x03, 0x01])).status).toBe(
			'invalid',
		);
	});
});
