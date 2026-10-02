import { describe, expect, test } from 'bun:test';
import { MimeError } from '../errors';
import { extractContent, parseMessage } from '../parse/message';
import { buildMessage, envelopeOf } from './message';

const DATE = new Date('2026-10-02T22:00:00Z');
const ASCII_CRLF = /^(?:[\x20-\x7e\t]*\r\n)*[\x20-\x7e\t]*$/;

describe('buildMessage', () => {
	test('a text message: its fields, 7bit, CRLF', () => {
		const message = buildMessage({
			from: 'John Doe <jdoe@machine.example>',
			to: { name: 'Mary Smith', address: 'mary@example.net' },
			subject: 'Saying Hello',
			date: DATE,
			messageId: '1234@local.machine.example',
			text: 'This is a message just to say hello.\nSo, "Hello".',
		});
		expect(message).toBe(
			[
				'Date: Fri, 02 Oct 2026 22:00:00 +0000',
				'From: John Doe <jdoe@machine.example>',
				'To: Mary Smith <mary@example.net>',
				'Subject: Saying Hello',
				'Message-ID: <1234@local.machine.example>',
				'MIME-Version: 1.0',
				'Content-Type: text/plain; charset=utf-8',
				'Content-Transfer-Encoding: 7bit',
				'',
				'This is a message just to say hello.',
				'So, "Hello".',
			].join('\r\n'),
		);
	});

	test('non-ASCII everywhere still writes 7-bit ASCII, and parses back', () => {
		const message = buildMessage({
			from: { name: 'André Pirard', address: 'andre@example.org' },
			to: ['Jörg <jorg@example.de>', 'plain@example.com'],
			subject: 'Réunion à 10h — ordre du jour',
			text: 'Bonjour,\nvoici l’ordre du jour : café, crème.',
			html: '<p>Bonjour, <b>café</b></p>',
			attachments: [
				{
					filename: 'résumé.pdf',
					contentType: 'application/pdf',
					content: new Uint8Array([1, 2, 3]),
				},
			],
		});
		expect(ASCII_CRLF.test(message)).toBe(true);
		for (const line of message.split('\r\n'))
			expect(line.length).toBeLessThanOrEqual(78);

		const parsed = parseMessage(message);
		expect(parsed.headers.text('subject')).toBe(
			'Réunion à 10h — ordre du jour',
		);
		expect(parsed.contentType.mediaType).toBe('multipart/mixed');
		const content = extractContent(parsed);
		expect(content.text).toBe(
			'Bonjour,\r\nvoici l’ordre du jour : café, crème.',
		);
		expect(content.html).toBe('<p>Bonjour, <b>café</b></p>');
		expect(content.attachments).toHaveLength(1);
		expect(content.attachments[0]?.filename).toBe('résumé.pdf');
		expect([...(content.attachments[0]?.content ?? [])]).toEqual([1, 2, 3]);
	});

	test('the nesting mail clients expect: mixed > related > alternative', () => {
		const message = parseMessage(
			buildMessage({
				from: 'a@example.com',
				to: 'b@example.com',
				text: 'see the logo',
				html: '<img src="cid:logo@example.com">',
				attachments: [
					{
						filename: 'logo.png',
						contentType: 'image/png',
						content: new Uint8Array([137, 80]),
						contentId: 'logo@example.com',
					},
					{
						filename: 'terms.txt',
						contentType: 'text/plain',
						content: 'terms',
					},
				],
			}),
		);
		expect(
			[...message.walk()].map(
				(part) => `${part.path}:${part.contentType.mediaType}`,
			),
		).toEqual([
			':multipart/mixed',
			'1:multipart/related',
			'1.1:multipart/alternative',
			'1.1.1:text/plain',
			'1.1.2:text/html',
			'1.2:image/png',
			'2:text/plain',
		]);
		const logo = message.children[0]?.children[1];
		expect(logo?.contentId).toBe('logo@example.com');
		expect(logo?.disposition?.type).toBe('inline');
		expect(message.children[1]?.disposition?.type).toBe('attachment');
	});

	test('Bcc is never written, and the envelope has every recipient once', () => {
		const options = {
			from: 'Sender <s@example.com>',
			to: ['a@example.com', 'b@example.com'],
			cc: 'b@example.com',
			bcc: { name: 'Hidden', address: 'h@example.com' },
			text: 'x',
		};
		expect(buildMessage(options)).not.toContain('h@example.com');
		expect(envelopeOf(options)).toEqual({
			from: 's@example.com',
			to: ['a@example.com', 'b@example.com', 'h@example.com'],
		});
	});

	test("a Message-ID at the sender's domain, replies and references", () => {
		const message = parseMessage(
			buildMessage({
				from: 'a@mail.example.com',
				inReplyTo: 'x@y',
				references: ['w@y', 'x@y'],
				text: '',
			}),
		);
		expect(message.headers.get('message-id')).toMatch(
			/^<[0-9a-f-]{36}@mail\.example\.com>$/,
		);
		expect(message.headers.get('in-reply-to')).toBe('<x@y>');
		expect(message.headers.get('references')).toBe('<w@y> <x@y>');
	});

	test('lines longer than 998 characters go out as quoted-printable', () => {
		const message = buildMessage({
			from: 'a@example.com',
			text: 'x'.repeat(2000),
		});
		expect(message).toContain('Content-Transfer-Encoding: quoted-printable');
		expect(parseMessage(message).text).toBe('x'.repeat(2000));
	});

	test('a long subject is folded, and unfolds to itself', () => {
		const subject = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
		const message = buildMessage({ from: 'a@example.com', subject, text: '' });
		expect(message.split('\r\n').every((line) => line.length <= 78)).toBe(true);
		expect(parseMessage(message).headers.get('subject')).toBe(subject);
	});

	test('extra headers are written, and a line break in one is refused', () => {
		const message = buildMessage({
			from: 'a@example.com',
			text: '',
			headers: {
				'List-Unsubscribe': '<mailto:u@example.com>',
				'X-Note': 'été',
			},
		});
		const parsed = parseMessage(message);
		expect(parsed.headers.get('list-unsubscribe')).toBe(
			'<mailto:u@example.com>',
		);
		expect(parsed.headers.text('x-note')).toBe('été');
		expect(() =>
			buildMessage({
				from: 'a@example.com',
				headers: { 'X-Evil': 'a\r\nBcc: x@y.test' },
			}),
		).toThrow(MimeError);
		expect(() =>
			buildMessage({ from: 'a@example.com', headers: { 'Bad Name': 'x' } }),
		).toThrow('is not a header field name');
	});

	test('an address that is not one is refused', () => {
		expect(() => buildMessage({ from: 'nobody' })).toThrow(
			'is not an e-mail address',
		);
	});
});
