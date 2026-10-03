import { describe, expect, test } from 'bun:test';
import { MAX_REPLY_LINES, ReplyReader, replyText } from './reply-reader';

const read = (...lines: string[]) => {
	const reader = new ReplyReader();
	return lines.map((line) => reader.line(line));
};

describe('ReplyReader (RFC 5321 §4.2)', () => {
	test('a one-line reply, its enhanced status code taken off (RFC 2034)', () => {
		expect(read('250 2.1.0 Sender OK')).toEqual([
			{ code: 250, status: '2.1.0', text: 'Sender OK' },
		]);
		expect(read('220 foo.com ESMTP ready')).toEqual([
			{ code: 220, text: 'foo.com ESMTP ready' },
		]);
		expect(read('354')).toEqual([{ code: 354, text: '' }]);
	});

	test('a multiline reply: code- lines, then code SP (§4.2.1, the EHLO example of §D.1)', () => {
		expect(
			read(
				'250-foo.com greets bar.com',
				'250-8BITMIME',
				'250-SIZE',
				'250-DSN',
				'250 HELP',
			),
		).toEqual([
			undefined,
			undefined,
			undefined,
			undefined,
			{
				code: 250,
				text: ['foo.com greets bar.com', '8BITMIME', 'SIZE', 'DSN', 'HELP'],
			},
		]);
	});

	test('a status on every line is taken off each; one whose class is not the code’s is text', () => {
		expect(read('550-5.1.1 No such', '550 5.1.1 user')).toEqual([
			undefined,
			{ code: 550, status: '5.1.1', text: ['No such', 'user'] },
		]);
		expect(read('250 5.1.1 odd')).toEqual([{ code: 250, text: '5.1.1 odd' }]);
	});

	test('not a reply: no code, a code out of range, a bad separator, a code that changes', () => {
		for (const line of ['hello', '25', '650 x', '199 x', '250x', '2a0 x']) {
			expect(read(line)[0]).toHaveProperty('error');
		}
		expect(read('250-a', '220 b')[1]).toEqual({
			error: 'a reply whose lines change code, from 250 to 220',
		});
	});

	test(`at most ${MAX_REPLY_LINES} lines`, () => {
		const lines = read(
			...Array.from({ length: MAX_REPLY_LINES + 1 }, () => '250-x'),
		);
		expect(lines.at(-1)).toEqual({
			error: `a reply of more than ${MAX_REPLY_LINES} lines`,
		});
	});

	test('a long line is cut in the error', () => {
		expect(read(`x${'y'.repeat(100)}`)[0]).toEqual({
			error: `a line that is not an SMTP reply: "x${'y'.repeat(39)}…"`,
		});
	});

	test('replyText joins the lines', () => {
		expect(replyText({ code: 250, text: ['a', 'b'] })).toBe('a b');
	});
});
