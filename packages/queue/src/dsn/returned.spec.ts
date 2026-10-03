import { describe, expect, test } from 'bun:test';
import { buildDsn } from './build';
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
