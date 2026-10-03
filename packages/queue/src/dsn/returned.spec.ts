import { describe, expect, test } from 'bun:test';
import { buildDsn } from './build';
import { MAX_LINE, returned } from './content';
import { at, decoder, encoder, input, parse } from './dsn.fixtures';

describe('the original, bounded', () => {
	test('returnContent full: the whole message as message/rfc822 when it fits', () => {
		const root = parse(buildDsn(input({ returnContent: 'full' })));
		expect(root.children[2]?.contentType.mediaType).toBe('message/rfc822');
		expect(
			decoder.decode(buildDsn(input({ returnContent: 'full' }))),
		).toContain('See you at noon.');
	});

	test('a message past maxReturn returns its headers only, cut after a whole line', () => {
		const dsn = buildDsn(input({ returnContent: 'full', maxReturn: 60 }));
		const part = parse(dsn).children[2];
		expect(part?.contentType.mediaType).toBe('text/rfc822-headers');
		expect(decoder.decode(part?.content)).toBe(
			'From: Mary <mary@example.net>\r\nTo: joe@example.com\r\n',
		);
		expect(decoder.decode(dsn)).not.toContain('See you at noon');
	});

	test('8-bit headers are declared 8bit; bare line breaks become CRLF', () => {
		const original = encoder.encode('Subject: Grüße\nX: y\r\n\r\nbody\r\n');
		const dsn = decoder.decode(buildDsn(input({ original })));
		expect(dsn).toContain(
			'Content-Type: text/rfc822-headers\r\nContent-Transfer-Encoding: 8bit\r\n\r\nSubject: Grüße\r\nX: y\r\n',
		);
	});
});

describe('no header injection from a reply or an address', () => {
	test('CR, LF and controls in a reply, a host or an address never start a field', () => {
		const dsn = decoder.decode(
			buildDsn(
				input({
					to: 'mary@example.net\r\nBcc: victim@example.org',
					recipients: [
						{
							address: 'joe@example.com\r\nX-Evil: 1',
							reply: {
								code: 550,
								text: 'no\r\nX-Injected: yes\u0000\u001b[31m',
								host: 'mx.example.com\r\nX-Host: 1',
							},
							lastAttempt: at('2026-10-01T12:05:00Z'),
						},
					],
				}),
			),
		);
		for (const field of ['Bcc:', 'X-Evil:', 'X-Injected:', 'X-Host:']) {
			expect(dsn).not.toContain(`\r\n${field}`);
		}
		expect(dsn).not.toContain('\u0000');
		expect(dsn).not.toContain('\u001b');
		expect(dsn).toContain('Diagnostic-Code: smtp; 550 no X-Injected: yes [31m');
		expect(dsn).not.toContain('Remote-MTA');
	});
});

describe('the lines returned', () => {
	const linesOf = (body: Uint8Array) =>
		new TextDecoder().decode(body).split('\r\n').slice(0, -1);

	test('a header line past 998 characters is cut at 998, the next ones kept', () => {
		const long = `X-Long: ${'a'.repeat(2000)}`;
		const original = encoder.encode(`${long}\r\nSubject: hi\r\n\r\nbody\r\n`);
		const { body } = returned(original, 'headers', 64 * 1024);
		expect(linesOf(body)).toEqual([long.slice(0, MAX_LINE), 'Subject: hi']);
	});

	test('a full message has every line cut too', () => {
		const original = encoder.encode(
			`Subject: hi\r\n\r\n${'b'.repeat(1500)}\r\n`,
		);
		const { body, type } = returned(original, 'full', 64 * 1024);
		expect(type).toBe('message/rfc822');
		expect(linesOf(body).map((line) => line.length)).toEqual([11, 0, MAX_LINE]);
	});

	test('the cut never splits a UTF-8 character', () => {
		// 997 ASCII bytes, then "é" (2 bytes) straddles the 998th.
		const long = `X: ${'a'.repeat(994)}é and more`;
		const { body } = returned(
			encoder.encode(`${long}\r\n\r\n`),
			'headers',
			4096,
		);
		const [line] = linesOf(body);
		expect(line).toBe(`X: ${'a'.repeat(994)}`);
		expect(body.every((byte) => byte !== 0xc3)).toBe(true);
	});
});
