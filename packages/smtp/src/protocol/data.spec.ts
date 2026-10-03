import { describe, expect, test } from 'bun:test';
import { DataReader } from './data';

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

function readAll(...chunks: string[]) {
	const reader = new DataReader();
	let out = '';
	for (const [i, chunk] of chunks.entries()) {
		const result = reader.write(bytes(chunk));
		out += text(result.data);
		if (result.done)
			return {
				out,
				done: true,
				rest: text(result.rest) + chunks.slice(i + 1).join(''),
				bare: reader.bareLineBreaks,
				size: reader.size,
			};
	}
	return {
		out,
		done: false,
		rest: '',
		bare: reader.bareLineBreaks,
		size: reader.size,
	};
}

describe('DataReader (RFC 5321 §4.1.1.4, §4.5.2)', () => {
	test('Appendix D.1: the message ends at <CRLF>.<CRLF>', () => {
		expect(readAll('Blah blah blah...\r\n...etc. etc. etc.\r\n.\r\n')).toEqual({
			out: 'Blah blah blah...\r\n..etc. etc. etc.\r\n',
			done: true,
			rest: '',
			bare: 0,
			size: 37,
		});
	});

	test('§4.5.2: a leading dot is removed, once', () => {
		expect(readAll('..\r\n...x\r\n.\r\n').out).toBe('.\r\n..x\r\n');
	});

	test('the terminator split across every chunk boundary', () => {
		const message = 'a\r\n.b\r\n.\r\nQUIT\r\n';
		for (let i = 1; i < message.length; i++) {
			const result = readAll(message.slice(0, i), message.slice(i));
			expect(result).toMatchObject({
				out: 'a\r\nb\r\n',
				done: true,
				rest: 'QUIT\r\n',
			});
		}
	});

	test('the commands pipelined after the message come back as rest', () => {
		expect(readAll('x\r\n.\r\nMAIL FROM:<a@b.c>\r\n').rest).toBe(
			'MAIL FROM:<a@b.c>\r\n',
		);
	});

	test('an empty message', () => {
		expect(readAll('.\r\n')).toMatchObject({ out: '', done: true });
	});

	describe('SMTP smuggling: only the exact <CRLF>.<CRLF> ends the message', () => {
		for (const [name, ending] of [
			['<LF>.<LF>', 'x\n.\nMAIL FROM:<evil@x.y>\r\n'],
			['<LF>.<CRLF>', 'x\n.\r\nMAIL FROM:<evil@x.y>\r\n'],
			['<CRLF>.<LF>', 'x\r\n.\nMAIL FROM:<evil@x.y>\r\n'],
			['<CR>.<CR>', 'x\r.\rMAIL FROM:<evil@x.y>\r\n'],
			['<CRLF>.<CR>', 'x\r\n.\rMAIL FROM:<evil@x.y>\r\n'],
		] as const) {
			test(`${name} does not end it, and counts as bare`, () => {
				const result = readAll(ending);
				expect(result.done).toBe(false);
				expect(result.bare).toBeGreaterThan(0);
			});
		}
	});

	test('a bare CR or LF inside a line is counted', () => {
		expect(readAll('a\rb\r\n.\r\n').bare).toBe(1);
		expect(readAll('a\nb\r\n.\r\n').bare).toBe(1);
		expect(readAll('a\r\nb\r\n.\r\n').bare).toBe(0);
	});

	test('fed one byte at a time', () => {
		const message = 'Subject: x\r\n\r\n..dot\r\n.\r\nNOOP\r\n';
		expect(readAll(...message)).toMatchObject({
			out: 'Subject: x\r\n\r\n.dot\r\n',
			done: true,
			rest: 'NOOP\r\n',
		});
	});
});
