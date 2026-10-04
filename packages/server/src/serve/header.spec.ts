import { describe, expect, test } from 'bun:test';
import {
	foreignAuthservId,
	HeaderEndScanner,
	headerEnd,
	returnPath,
	splitFields,
	stripForged,
} from './header';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (parts: readonly Uint8Array[]) =>
	parts.map((part) => new TextDecoder().decode(part)).join('');

describe('headerEnd', () => {
	test('finds the blank line, and nothing without one', () => {
		const message = bytes('A: 1\r\nB: 2\r\n\r\nbody\r\n\r\n');
		expect(headerEnd(message)).toBe(12);
		expect(headerEnd(bytes('A: 1\r\nB: 2\r\n'))).toBe(-1);
		expect(headerEnd(bytes('\r\nbody'))).toBe(0);
	});

	test('finds a blank line split across what was already looked at', () => {
		const message = bytes('A: 1\r\n\r\nbody');
		expect(headerEnd(message, 5)).toBe(6);
	});
});

describe('splitFields', () => {
	test('keeps folded lines with their field, byte for byte', () => {
		const fields = splitFields(bytes('A: 1\r\n  more\r\nB:\t2\r\n'));
		expect(fields.map((f) => new TextDecoder().decode(f))).toEqual([
			'A: 1\r\n  more\r\n',
			'B:\t2\r\n',
		]);
	});
});

describe('foreignAuthservId (RFC 8601 §2.2): an allow-list', () => {
	test.each([
		['Authentication-Results: example.com; none\r\n', 'example.com'],
		['Authentication-Results:  Example.COM 1; spf=pass\r\n', 'example.com'],
		['Authentication-Results: (c (nested)) example.com;\r\n', 'example.com'],
		['Authentication-Results:\r\n example.com;\r\n', 'example.com'],
		['Authentication-Results: "example.com"; none\r\n', 'example.com'],
		['Authentication-Results: example.com. (c) 1 (d) ;\r\n', 'example.com'],
	])('%j names %j', (field, id) => {
		expect(foreignAuthservId(bytes(field))).toBe(id);
	});

	test.each([
		['an empty id', 'Authentication-Results: ; none\r\n'],
		['a comment never closed', 'Authentication-Results: (open\r\n'],
		['no semicolon after it', 'Authentication-Results: example.com\r\n'],
		[
			'something after a version',
			'Authentication-Results: example.com 1x;\r\n',
		],
		['an underscore', 'Authentication-Results: ex_ample.com;\r\n'],
		['a quote never closed', 'Authentication-Results: "example.com;\r\n'],
		['a bare LF', 'Authentication-Results:\n example.com;\r\n'],
	])('%s is no foreign id', (_, field) => {
		expect(foreignAuthservId(bytes(field))).toBeUndefined();
	});
});

/** An `Authentication-Results` field with `id` as written, then `; dmarc=pass`. */
function claim(id: string | Uint8Array): Uint8Array {
	const head = bytes('Authentication-Results: ');
	const tail = bytes('; dmarc=pass\r\n');
	const middle = typeof id === 'string' ? bytes(id) : id;
	const out = new Uint8Array(head.length + middle.length + tail.length);
	out.set(head);
	out.set(middle, head.length);
	out.set(tail, head.length + middle.length);
	return out;
}

describe('stripForged: anything a reader may take for the server goes', () => {
	const host = 'mail.example.com';
	test.each([
		['NUL after', 'mail.example.com\u0000'],
		['\\x01 after', 'mail.example.com\u0001'],
		['DEL after', 'mail.example.com\u007f'],
		['a slash', 'mail.example.com/x'],
		['a comma', 'mail.example.com,x'],
		['an equals sign', 'mail.example.com=x'],
		['a zero-width space after', 'mail.example.com​'],
		['a zero-width space inside', 'mail.exa​mple.com'],
		['a soft hyphen after', 'mail.example.com­'],
		['a soft hyphen inside', 'mail.exam­ple.com'],
		['VT first', '\u000bmail.example.com'],
		['FF first', '\u000cmail.example.com'],
		['NBSP first', ' mail.example.com'],
		['a BOM first', '﻿mail.example.com'],
		['a fullwidth dot', 'mail．example.com'],
		['an ideographic full stop', 'mail。example.com'],
		['fullwidth letters', 'ｍａｉｌ.example.com'],
		['a small roman numeral one thousand', 'mail.example.coⅿ'],
		['a control character in another name', 'other\u0001.example'],
		['a trailing dot', 'mail.example.com.'],
		['another case', 'MAIL.Example.COM'],
		['the hostname quoted', '"mail.example.com"'],
		['the hostname itself', 'mail.example.com'],
		['an empty id', ''],
	])('%s', (_, id) => {
		expect(stripForged(claim(id), host).removed).toBe(1);
	});

	test.each([
		['0xFF', 0xff],
		['0x80', 0x80],
	])('a raw %s byte before the hostname', (_, byte) => {
		const id = new Uint8Array([byte, ...bytes('mail.example.com')]);
		expect(stripForged(claim(id), host).removed).toBe(1);
	});

	test('the U-label of a hostname given as its A-label', () => {
		const field = claim('mail.bücher.example');
		expect(stripForged(field, 'mail.xn--bcher-kva.example').removed).toBe(1);
		// And the A-label, for a hostname given as its U-label.
		const ascii = claim('mail.xn--bcher-kva.example');
		expect(stripForged(ascii, 'mail.bücher.example').removed).toBe(1);
	});

	test('a field in the name of a domain the server hosts, in any case or with a dot', () => {
		const hosted = (id: string) => id === 'example.com';
		for (const id of ['example.com', 'Example.COM', 'example.com.']) {
			expect(stripForged(claim(id), host, hosted).removed).toBe(1);
		}
		expect(stripForged(claim('other.example'), host, hosted).removed).toBe(0);
	});

	test('a field with no authserv-id at all goes; ARC-Authentication-Results stays', () => {
		const none = bytes(
			'Authentication-Results: spf=pass smtp.mailfrom=x.example\r\n',
		);
		expect(stripForged(none, host).removed).toBe(1);
		const arc = bytes(
			'ARC-Authentication-Results: i=1; mail.example.com; dmarc=pass\r\n',
		);
		const { kept, removed } = stripForged(arc, host);
		expect(removed).toBe(0);
		expect(kept).toEqual([arc]);
	});

	test("a foreign server's field is kept byte for byte", () => {
		const field = bytes('Authentication-Results: mx.google.com; dkim=pass\r\n');
		const { kept, removed } = stripForged(field, host);
		expect(removed).toBe(0);
		expect(kept).toEqual([field]);
		for (const id of ['mail.example.community', 'relay.other.example 1']) {
			expect(stripForged(claim(id), host).removed).toBe(0);
		}
	});
});

describe('stripForged', () => {
	test("takes out the fields claiming the server's name and every Return-Path", () => {
		const header = bytes(
			[
				'Received: from a by b; now',
				'Authentication-Results: mail.example.com; dmarc=pass',
				'authentication-results: MAIL.example.com.; spf=pass',
				'Authentication-Results: mail.example.com.evil.example; spf=pass',
				'Authentication-Results: mail.example.community; spf=pass',
				'Return-Path: <x@y>',
				'From: <a@b>',
				'',
			].join('\r\n'),
		);
		const { kept, removed } = stripForged(header, 'mail.example.com');
		// Another host's name, however it starts, is another server's.
		expect(removed).toBe(3);
		expect(text(kept)).toBe(
			'Received: from a by b; now\r\nAuthentication-Results: mail.example.com.evil.example; spf=pass\r\nAuthentication-Results: mail.example.community; spf=pass\r\nFrom: <a@b>\r\n',
		);
	});
});

describe('returnPath (RFC 5321 §4.4)', () => {
	test('writes the envelope sender, <> for a bounce', () => {
		expect(returnPath('joe@example.com')).toBe(
			'Return-Path: <joe@example.com>\r\n',
		);
		expect(returnPath('')).toBe('Return-Path: <>\r\n');
		expect(returnPath('a\r\nB: c')).toBe('Return-Path: <>\r\n');
	});
});

describe('HeaderEndScanner', () => {
	test('finds the blank line wherever the chunks split it', () => {
		for (const whole of [
			'A: 1\r\nB: 2\r\n\r\nbody\r\n\r\n',
			'\r\nbody',
			'A: 1\r\n\r\r\n\r\nx',
			'A: 1\r\n',
		]) {
			const data = bytes(whole);
			const expected = headerEnd(data);
			for (let size = 1; size <= data.length; size++) {
				const scanner = new HeaderEndScanner();
				for (let at = 0; at < data.length; at += size) {
					scanner.add(data.subarray(at, at + size));
				}
				expect(scanner.end).toBe(expected);
				expect(scanner.length).toBe(data.length);
			}
		}
	});
});
