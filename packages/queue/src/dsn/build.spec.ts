import { describe, expect, test } from 'bun:test';
import { parseHeaderBlock, parseMessage } from '@bumail/mime';
import { buildDsn, type DsnInput } from './build';
import { typedAddress } from './fields';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ORIGINAL =
	'From: Mary <mary@example.net>\r\nTo: joe@example.com\r\nSubject: Lunch\r\nMessage-ID: <1@example.net>\r\n\r\nSee you at noon.\r\n';

const at = (iso: string) => new Date(iso);

function input(overrides: Partial<DsnInput> = {}): DsnInput {
	return {
		kind: 'failed',
		reportingMta: 'mail.example.net',
		from: 'postmaster@example.net',
		to: 'mary@example.net',
		arrival: at('2026-10-01T12:00:00Z'),
		date: at('2026-10-01T12:05:00Z'),
		recipients: [
			{
				address: 'joe@example.com',
				reply: {
					code: 550,
					status: '5.1.1',
					text: 'Requested action not taken: mailbox unavailable',
					host: 'mx.example.com',
				},
				lastAttempt: at('2026-10-01T12:05:00Z'),
			},
		],
		original: encoder.encode(ORIGINAL),
		returnContent: 'headers',
		maxReturn: 64 * 1024,
		...overrides,
	};
}

const parse = (dsn: Uint8Array) => parseMessage(dsn);
const fieldsOf = (text: string) =>
	text
		.trim()
		.split(/\r\n\r\n/)
		.map((block) => parseHeaderBlock(encoder.encode(`${block}\r\n\r\n`)));

describe('RFC 3464 §2 and RFC 6522 §3: a multipart/report of three parts', () => {
	test('text for a person, message/delivery-status, then the original headers', () => {
		const root = parse(buildDsn(input()));
		expect(root.contentType.mediaType).toBe('multipart/report');
		expect(root.contentType.parameters['report-type']).toBe('delivery-status');
		expect(root.children.map((p) => p.contentType.mediaType)).toEqual([
			'text/plain',
			'message/delivery-status',
			'text/rfc822-headers',
		]);
		expect(root.children[0]?.text).toContain(
			'<joe@example.com>: 550 Requested action not taken',
		);
		expect(decoder.decode(root.children[2]?.content)).toBe(
			'From: Mary <mary@example.net>\r\nTo: joe@example.com\r\nSubject: Lunch\r\nMessage-ID: <1@example.net>\r\n',
		);
	});

	test('the header fields: to the sender, from the postmaster, auto-replied (RFC 3834 §5)', () => {
		const { headers } = parse(buildDsn(input()));
		expect(headers.get('to')).toBe('<mary@example.net>');
		expect(headers.get('from')).toBe(
			'Mail Delivery System <postmaster@example.net>',
		);
		expect(headers.get('subject')).toBe('Undelivered Mail Returned to Sender');
		expect(headers.get('auto-submitted')).toBe('auto-replied');
		expect(headers.get('date')).toBe('Thu, 01 Oct 2026 12:05:00 +0000');
		expect(headers.get('message-id')).toMatch(
			/^<[0-9a-f-]+@mail\.example\.net>$/,
		);
	});
});

describe('RFC 3464 §2.2 and §2.3: the delivery-status fields', () => {
	test('per message, then per recipient, as the RFC writes them', () => {
		const status = parse(buildDsn(input())).children[1];
		const [message, recipient] = fieldsOf(decoder.decode(status?.content));
		expect(message?.get('reporting-mta')).toBe('dns; mail.example.net');
		expect(message?.get('arrival-date')).toBe(
			'Thu, 01 Oct 2026 12:00:00 +0000',
		);
		expect(recipient?.get('final-recipient')).toBe('rfc822; joe@example.com');
		expect(recipient?.get('action')).toBe('failed');
		expect(recipient?.get('status')).toBe('5.1.1');
		expect(recipient?.get('remote-mta')).toBe('dns; mx.example.com');
		expect(recipient?.get('diagnostic-code')).toBe(
			'smtp; 550 Requested action not taken: mailbox unavailable',
		);
		expect(recipient?.get('last-attempt-date')).toBe(
			'Thu, 01 Oct 2026 12:05:00 +0000',
		);
		expect(recipient?.has('will-retry-until')).toBe(false);
	});

	test('§2.3.3 "delayed", with Will-Retry-Until (§2.3.9)', () => {
		const dsn = buildDsn(
			input({
				kind: 'delayed',
				recipients: [
					{
						address: 'joe@example.com',
						reply: { code: 451, status: '4.3.0', text: 'busy' },
						lastAttempt: at('2026-10-01T16:00:00Z'),
					},
				],
				willRetryUntil: at('2026-10-06T12:00:00Z'),
			}),
		);
		const root = parse(dsn);
		expect(root.headers.get('subject')).toBe(
			'Delayed Mail (still being retried)',
		);
		const [, recipient] = fieldsOf(decoder.decode(root.children[1]?.content));
		expect(recipient?.get('action')).toBe('delayed');
		expect(recipient?.get('status')).toBe('4.3.0');
		expect(recipient?.get('will-retry-until')).toBe(
			'Tue, 06 Oct 2026 12:00:00 +0000',
		);
		expect(root.children[0]?.text).toContain('still being retried');
	});

	test('one block per recipient; an error with no reply is X-Bumail, its status kept', () => {
		const dsn = buildDsn(
			input({
				recipients: [
					{ address: 'a@example.com', lastAttempt: at('2026-10-01T12:05:00Z') },
					{
						address: 'b@example.org',
						reply: { status: '5.1.10', text: 'example.org accepts no mail' },
						lastAttempt: at('2026-10-01T12:05:00Z'),
					},
				],
			}),
		);
		const blocks = fieldsOf(decoder.decode(parse(dsn).children[1]?.content));
		expect(blocks).toHaveLength(3);
		expect(blocks[1]?.get('status')).toBe('5.0.0');
		expect(blocks[2]?.get('status')).toBe('5.1.10');
		expect(blocks[2]?.get('diagnostic-code')).toBe(
			'X-Bumail; example.org accepts no mail',
		);
	});

	test('RFC 6533 §3: a UTF-8 address is typed utf-8, each non-ASCII character as \\x{HEX}', () => {
		expect(typedAddress('joe@example.com')).toBe('rfc822; joe@example.com');
		expect(typedAddress('jörg@bücher.example')).toBe(
			'utf-8; j\\x{F6}rg@b\\x{FC}cher.example',
		);
	});
});

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
