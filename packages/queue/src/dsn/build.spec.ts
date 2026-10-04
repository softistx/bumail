import { describe, expect, test } from 'bun:test';
import { buildDsn } from './build';
import { at, decoder, fieldsOf, input, parse } from './dsn.fixtures';
import { typedAddress } from './fields';

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

	test('with no original (the store lost it), two parts: the third is optional', () => {
		const { original: _, ...lost } = input();
		const dsn = buildDsn(lost);
		const root = parse(dsn);
		expect(root.contentType.mediaType).toBe('multipart/report');
		expect(root.children.map((p) => p.contentType.mediaType)).toEqual([
			'text/plain',
			'message/delivery-status',
		]);
		expect(root.children[0]?.text).toContain(
			'Your message could not be read from the queue, so it is not returned.',
		);
		const boundary = root.contentType.parameters['boundary'];
		expect(decoder.decode(dsn)).toEndWith(`\r\n--${boundary}--\r\n`);
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

	test('the longest UTF-8 address the queue takes still fits a header line, cut', () => {
		const address = `${'中'.repeat(64)}@${'中'.repeat(180)}.cn`;
		const dsn = new TextDecoder().decode(
			buildDsn(
				input({
					recipients: [
						{ address, lastAttempt: at('2026-10-01T12:05:00Z') },
						{
							address: 'b@example.org',
							lastAttempt: at('2026-10-01T12:05:00Z'),
						},
					],
				}),
			),
		);
		const line = dsn
			.split('\r\n')
			.find((l) => l.startsWith('Final-Recipient: utf-8;'));
		expect(line?.length).toBeLessThanOrEqual(998);
		expect(dsn).toContain('Final-Recipient: rfc822; b@example.org');
	});

	test('an expired recipient keeps the remote reply, and the text says the time ran out', () => {
		const root = parse(
			buildDsn(
				input({
					recipients: [
						{
							address: 'joe@example.com',
							reply: { code: 451, status: '4.4.7', text: 'Try again later' },
							lastAttempt: at('2026-10-06T12:00:00Z'),
						},
					],
				}),
			),
		);
		const [, recipient] = fieldsOf(decoder.decode(root.children[1]?.content));
		expect(recipient?.get('status')).toBe('4.4.7');
		expect(recipient?.get('diagnostic-code')).toBe('smtp; 451 Try again later');
		expect(root.children[0]?.text).toContain(
			'<joe@example.com>: delivery time expired, still failing: 451 Try again later',
		);
	});
});
