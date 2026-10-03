import { describe, expect, test } from 'bun:test';
import { formatDateTime, parseDate, parseDateTime } from './dates';
import { Response } from './response';
import { decodePlain } from './sasl';
import { decodeUtf7, encodeUtf7 } from './utf7';

const wire = (pieces: readonly (string | Uint8Array | Blob)[]) =>
	pieces
		.map((piece) =>
			typeof piece === 'string'
				? piece
				: new TextDecoder().decode(piece as Uint8Array),
		)
		.join('');

describe('Response', () => {
	test('a string is quoted when it can be, a literal otherwise', () => {
		const line = new Response()
			.text('* X ')
			.string('a "b"')
			.text(' ')
			.string('two\r\nlines')
			.text(' ')
			.string('café')
			.done();
		expect(wire(line)).toBe(
			'* X "a \\"b\\"" {10}\r\ntwo\r\nlines {5}\r\ncafé\r\n',
		);
	});

	test('astring: an atom when it can be, never a bare NIL', () => {
		const line = new Response()
			.astring('INBOX')
			.text(' ')
			.astring('NIL')
			.text(' ')
			.astring('a b')
			.done();
		expect(wire(line)).toBe('INBOX "NIL" "a b"\r\n');
	});

	test('nstring', () => {
		expect(wire(new Response().nstring(undefined).done())).toBe('NIL\r\n');
	});
});

describe('dates', () => {
	test('INTERNALDATE in UTC', () => {
		expect(formatDateTime(new Date('1996-07-17T09:44:25Z'))).toBe(
			'"17-Jul-1996 09:44:25 +0000"',
		);
	});

	test('a SEARCH date is the UTC midnight that starts it', () => {
		expect(parseDate('1-Feb-1994')).toBe(Date.UTC(1994, 1, 1));
		expect(parseDate('31-Feb-1994')).toBeUndefined();
		expect(parseDate('1-Fev-1994')).toBeUndefined();
	});

	test("APPEND's date-time, with its zone (RFC 9051 §6.3.12)", () => {
		expect(parseDateTime(' 7-Feb-1994 21:52:25 -0800')?.toISOString()).toBe(
			'1994-02-08T05:52:25.000Z',
		);
		expect(parseDateTime('07-Feb-1994 21:52:25')).toBeUndefined();
	});
});

describe('modified UTF-7 (RFC 3501 §5.1.3)', () => {
	test("the RFC's example", () => {
		expect(encodeUtf7('~peter/mail/台北/日本語')).toBe(
			'~peter/mail/&U,BTFw-/&ZeVnLIqe-',
		);
		expect(decodeUtf7('~peter/mail/&U,BTFw-/&ZeVnLIqe-')).toBe(
			'~peter/mail/台北/日本語',
		);
	});

	test('& is &-', () => {
		expect(encodeUtf7('Tom & Jerry')).toBe('Tom &- Jerry');
		expect(decodeUtf7('Tom &- Jerry')).toBe('Tom & Jerry');
	});

	test('what is not valid', () => {
		expect(decodeUtf7('&U,BTFw')).toBeUndefined();
		expect(decodeUtf7('&AGE-')).toBeUndefined();
		expect(decodeUtf7('café')).toBeUndefined();
	});
});

describe('decodePlain (RFC 4616)', () => {
	test('authzid NUL authcid NUL passwd', () => {
		const response = new TextEncoder().encode('\0alice\0secret').toBase64();
		expect(decodePlain(response)).toEqual({
			mechanism: 'PLAIN',
			username: 'alice',
			password: 'secret',
		});
	});

	test('what does not decode', () => {
		expect(decodePlain('not base64!')).toBeUndefined();
		expect(
			decodePlain(new TextEncoder().encode('alice').toBase64()),
		).toBeUndefined();
	});
});
