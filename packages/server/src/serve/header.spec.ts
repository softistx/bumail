import { describe, expect, test } from 'bun:test';
import {
	authservId,
	claimsHost,
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

describe('authservId (RFC 8601 §2.2)', () => {
	test.each([
		['Authentication-Results: example.com; none\r\n', 'example.com'],
		['Authentication-Results:  Example.COM 1; spf=pass\r\n', 'example.com'],
		['Authentication-Results: (c (nested)) example.com;\r\n', 'example.com'],
		['Authentication-Results:\r\n example.com;\r\n', 'example.com'],
		['Authentication-Results: "exa\\mple.com"; none\r\n', 'example.com'],
		['Authentication-Results: ; none\r\n', ''],
		['Authentication-Results: (unterminated\r\n', ''],
	])('%j claims %j', (field, id) => {
		expect(authservId(bytes(field))).toBe(id);
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
		// mail.example.com.evil.example goes too: erring towards removal costs nothing.
		expect(removed).toBe(4);
		expect(text(kept)).toBe(
			'Received: from a by b; now\r\nAuthentication-Results: mail.example.community; spf=pass\r\nFrom: <a@b>\r\n',
		);
	});
});

describe('claimsHost: an id a reader may take for the server', () => {
	const host = 'mail.example.com';
	test.each([
		['NUL', 'mail.example.com\u0000'],
		['\\x01', 'mail.example.com\u0001'],
		['DEL', 'mail.example.com\u007f'],
		['a slash', 'mail.example.com/x'],
		['a comma', 'mail.example.com,x'],
		['an equals sign', 'mail.example.com=x'],
		['a zero-width space after', 'mail.example.com\u200b'],
		['a zero-width space inside', 'mail.exa\u200bmple.com'],
		['a soft hyphen after', 'mail.example.com\u00ad'],
		['a soft hyphen inside', 'mail.exam\u00adple.com'],
		['a control character anywhere', 'other\u0001.example'],
		['a trailing dot', 'mail.example.com.'],
		['the hostname itself', 'mail.example.com'],
	])('%s is a claim', (_, id) => {
		expect(claimsHost(id, host)).toBe(true);
	});

	test.each([
		'mail.example.community',
		'mail.example.co',
		'relay.other.example',
		'xmail.example.com',
	])('%s is not', (id) => {
		expect(claimsHost(id, host)).toBe(false);
	});

	test('a field whose id hides a control character is stripped', () => {
		for (const id of ['mail.example.com\u0000', 'mail.example.com\u007f']) {
			const header = bytes(`Authentication-Results: ${id}; dmarc=pass\r\n`);
			expect(stripForged(header, host).removed).toBe(1);
		}
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
