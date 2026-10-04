import { describe, expect, test } from 'bun:test';
import {
	authservId,
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
				'Return-Path: <x@y>',
				'From: <a@b>',
				'',
			].join('\r\n'),
		);
		const { kept, removed } = stripForged(header, 'mail.example.com');
		expect(removed).toBe(3);
		expect(text(kept)).toBe(
			'Received: from a by b; now\r\nAuthentication-Results: mail.example.com.evil.example; spf=pass\r\nFrom: <a@b>\r\n',
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
