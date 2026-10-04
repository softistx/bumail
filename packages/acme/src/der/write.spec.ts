import { describe, expect, test } from 'bun:test';
import { readDer, readInteger, readOid, readText } from './read.fixtures';
import {
	bitString,
	encodeLength,
	explicit,
	ia5String,
	implicit,
	integer,
	nullValue,
	octetString,
	oid,
	printableString,
	sequence,
	set,
	utf8String,
} from './write';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

describe('lengths (X.690 §8.1.3)', () => {
	test('short form below 128, long form from 128', () => {
		expect(hex(encodeLength(0))).toBe('00');
		expect(hex(encodeLength(127))).toBe('7f');
		expect(hex(encodeLength(128))).toBe('8180');
		expect(hex(encodeLength(255))).toBe('81ff');
		expect(hex(encodeLength(256))).toBe('820100');
		expect(hex(encodeLength(65_536))).toBe('83010000');
	});

	test('a content of 300 bytes reads back whole', () => {
		const node = readDer(octetString(new Uint8Array(300).fill(7)));
		expect(hex(node.raw.subarray(0, 4))).toBe('0482012c');
		expect(node.content.length).toBe(300);
	});

	test('a negative or fractional length is a bug', () => {
		expect(() => encodeLength(-1)).toThrow(RangeError);
		expect(() => encodeLength(1.5)).toThrow(RangeError);
	});
});

describe('INTEGER (X.690 §8.3)', () => {
	test.each([
		[0, '020100'],
		[1, '020101'],
		[127, '02017f'],
		[128, '02020080'],
		[255, '020200ff'],
		[256, '02020100'],
		[32_767, '02027fff'],
		[32_768, '0203008000'],
	])('%p is %s', (value, expected) => {
		expect(hex(integer(value))).toBe(expected);
		expect(hex(integer(BigInt(value)))).toBe(expected);
	});

	test('a big positive bigint, high bit set, gets a leading 0x00', () => {
		const value = 2n ** 255n;
		const encoded = integer(value);
		expect(hex(encoded.subarray(0, 3))).toBe('022100');
		expect(encoded.length).toBe(2 + 33);
		expect(readInteger(readDer(encoded))).toBe(value);
	});

	test('a big bigint without the high bit takes no 0x00', () => {
		expect(hex(integer(2n ** 64n))).toBe('0209010000000000000000');
	});

	test('magnitude bytes: leading zeros trimmed, 0x00 put back for a high bit', () => {
		expect(hex(integer(Uint8Array.of(0, 0, 0x01)))).toBe('020101');
		expect(hex(integer(Uint8Array.of(0, 0, 0x80)))).toBe('02020080');
		expect(hex(integer(Uint8Array.of(0x80, 0)))).toBe('0203008000');
		expect(hex(integer(Uint8Array.of(0x7f, 0xff)))).toBe('02027fff');
		expect(hex(integer(Uint8Array.of(0, 0, 0)))).toBe('020100');
		expect(hex(integer(new Uint8Array()))).toBe('020100');
	});

	test('32 bytes of 0xff, as an ECDSA r can be, read back as themselves', () => {
		const bytes = new Uint8Array(32).fill(0xff);
		const encoded = integer(bytes);
		expect(encoded.length).toBe(2 + 33);
		expect(readInteger(readDer(encoded))).toBe(2n ** 256n - 1n);
	});

	test('a negative or unsafe number is a bug', () => {
		expect(() => integer(-1)).toThrow(RangeError);
		expect(() => integer(-1n)).toThrow(RangeError);
		expect(() => integer(2 ** 60)).toThrow(RangeError);
	});
});

describe('OBJECT IDENTIFIER (X.690 §8.19)', () => {
	test.each([
		['1.2.840.113549', '06062a864886f70d'],
		['2.5.29.17', '0603551d11'],
		['2.5.4.3', '0603550403'],
		['1.2.840.10045.4.3.2', '06082a8648ce3d040302'],
		['1.2.840.113549.1.9.14', '06092a864886f70d01090e'],
		['1.2.840.113549.1.1.11', '06092a864886f70d01010b'],
		['2.999.3', '0603883703'],
	])('%s', (dotted, expected) => {
		expect(hex(oid(dotted))).toBe(expected);
		expect(readOid(readDer(oid(dotted)))).toBe(dotted);
	});

	test('what is not an OID is a bug', () => {
		for (const bad of ['', '1', '3.1', '1.40', '1..2', 'a.b']) {
			expect(() => oid(bad)).toThrow(RangeError);
		}
	});
});

describe('strings, BIT STRING, OCTET STRING, NULL', () => {
	test('UTF8String keeps any text', () => {
		const encoded = utf8String('héllo');
		expect(encoded[0]).toBe(0x0c);
		expect(readText(readDer(encoded))).toBe('héllo');
	});

	test('PrintableString and IA5String refuse what they cannot hold', () => {
		expect(hex(printableString('Ab 1'))).toBe('130441622031');
		expect(() => printableString('a*b')).toThrow(RangeError);
		expect(hex(ia5String('a*b'))).toBe('1603612a62');
		expect(() => ia5String('é')).toThrow(RangeError);
	});

	test('BIT STRING starts with its count of unused bits', () => {
		expect(hex(bitString(Uint8Array.of(0xab)))).toBe('030200ab');
		expect(hex(bitString(Uint8Array.of(0xa0), 5))).toBe('030205a0');
		expect(() => bitString(Uint8Array.of(1), 8)).toThrow(RangeError);
		expect(() => bitString(new Uint8Array(), 1)).toThrow(RangeError);
	});

	test('OCTET STRING and NULL', () => {
		expect(hex(octetString(Uint8Array.of(1, 2)))).toBe('04020102');
		expect(hex(nullValue())).toBe('0500');
	});
});

describe('SEQUENCE, SET and context tags', () => {
	test('a SEQUENCE keeps its order', () => {
		expect(hex(sequence(integer(2), integer(1)))).toBe('3006020102020101');
		expect(hex(sequence())).toBe('3000');
	});

	test('a SET OF sorts its encodings (X.690 §11.6)', () => {
		expect(hex(set(integer(2), integer(1)))).toBe('3106020101020102');
		expect(
			hex(set(octetString(Uint8Array.of(1, 2)), octetString(Uint8Array.of(1)))),
		).toBe('310704010104020102');
	});

	test('[n] EXPLICIT is constructed around the encodings', () => {
		expect(hex(explicit(0, integer(2)))).toBe('a003020102');
		expect(hex(explicit(3, sequence()))).toBe('a3023000');
	});

	test('[n] IMPLICIT replaces the tag, keeping the constructed bit', () => {
		expect(hex(implicit(2, ia5String('a.b')))).toBe('8203612e62');
		expect(hex(implicit(0, set(integer(1))))).toBe('a003020101');
		expect(() => implicit(31, nullValue())).toThrow(RangeError);
		expect(() => implicit(0, new Uint8Array())).toThrow(RangeError);
	});
});
