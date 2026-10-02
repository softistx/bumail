import { describe, expect, test } from 'bun:test';
import { formatReply, reply } from './reply';

describe('formatReply', () => {
	test('one line: code, space, enhanced status, text, CRLF (RFC 2034 §4)', () => {
		expect(formatReply(reply(250, '2.1.0', 'OK'))).toBe('250 2.1.0 OK\r\n');
	});

	test('several lines: `code-` on each but the last (RFC 5321 §4.2.1)', () => {
		expect(
			formatReply(
				reply(250, undefined, [
					'foo.com greets bar.com',
					'8BITMIME',
					'SIZE',
					'HELP',
				]),
			),
		).toBe(
			'250-foo.com greets bar.com\r\n250-8BITMIME\r\n250-SIZE\r\n250 HELP\r\n',
		);
	});

	test('the enhanced status repeats on every line', () => {
		expect(formatReply(reply(550, '5.7.1', ['a', 'b']))).toBe(
			'550-5.7.1 a\r\n550 5.7.1 b\r\n',
		);
	});

	test('without ENHANCEDSTATUSCODES, no status', () => {
		expect(formatReply(reply(250, '2.0.0', 'OK'), false)).toBe('250 OK\r\n');
	});

	test('a line break in the text cannot start a second reply', () => {
		expect(formatReply(reply(250, undefined, 'a\r\n250 forged'))).toBe(
			'250 a 250 forged\r\n',
		);
	});
});
