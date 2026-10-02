import { describe, expect, test } from 'bun:test';
import { MimeError } from '../errors';
import { parseMessage } from './message';
import { type MimeEvent, MimeParser, parseMimeStream } from './stream';

const MESSAGE = new TextEncoder().encode(
	[
		'Subject: chunks',
		'Content-Type: multipart/mixed; boundary="=_b"',
		'',
		'preamble',
		'--=_b',
		'Content-Type: text/plain; charset=utf-8',
		'Content-Transfer-Encoding: quoted-printable',
		'',
		'caf=C3=A9 =',
		'cr=C3=A8me',
		'--=_b',
		'Content-Type: application/octet-stream',
		'Content-Transfer-Encoding: base64',
		'',
		'AAECAwQF',
		'BgcICQ==',
		'--=_b--',
		'',
	].join('\r\n'),
);

function summary(events: readonly MimeEvent[]): string[] {
	const out: string[] = [];
	for (const event of events) {
		if (event.type === 'body') {
			const last = out[out.length - 1];
			const text = new TextDecoder().decode(event.data);
			if (last?.startsWith(`body ${event.part.path}:`))
				out[out.length - 1] = last + text;
			else out.push(`body ${event.part.path}:${text}`);
		} else {
			out.push(`${event.type} ${event.part.path}`);
		}
	}
	return out;
}

describe('MimeParser', () => {
	test('reports headers, raw body chunks and ends, in order', () => {
		const parser = new MimeParser();
		const events = [...parser.write(MESSAGE), ...parser.end()];
		expect(summary(events)).toEqual([
			'headers ',
			'headers 1',
			'body 1:caf=C3=A9 =\r\ncr=C3=A8me',
			'end 1',
			'headers 2',
			'body 2:AAECAwQF\r\nBgcICQ==',
			'end 2',
			'end ',
		]);
	});

	test('gives the same events whatever the chunk size', () => {
		const reference = (() => {
			const parser = new MimeParser();
			return summary([...parser.write(MESSAGE), ...parser.end()]);
		})();
		for (const size of [1, 2, 3, 7, 64]) {
			const parser = new MimeParser();
			const events: MimeEvent[] = [];
			for (let i = 0; i < MESSAGE.length; i += size) {
				events.push(...parser.write(MESSAGE.subarray(i, i + size)));
			}
			events.push(...parser.end());
			expect(summary(events)).toEqual(reference);
		}
	});

	test('a CRLF split across two chunks is still one line break', () => {
		const parser = new MimeParser();
		const text = new TextEncoder().encode('Subject: x\r\n\r\nbody\r\n');
		const events = [
			...parser.write(text.subarray(0, 11)),
			...parser.write(text.subarray(11)),
			...parser.end(),
		];
		expect(summary(events)).toEqual(['headers ', 'body :body\r\n', 'end ']);
	});

	test('a body is never held: a long line is passed on before its end', () => {
		const parser = new MimeParser({ maxLineBytes: 1024 });
		parser.write(new TextEncoder().encode('Subject: big\r\n\r\n'));
		let seen = 0;
		const chunk = new Uint8Array(4096).fill(0x61);
		for (let i = 0; i < 256; i++) {
			for (const event of parser.write(chunk)) {
				if (event.type === 'body') seen += event.data.length;
			}
		}
		// 1 MiB without a line break: all but the last byte is out already.
		expect(seen).toBe(256 * 4096 - 1);
		const last = parser.end();
		expect(
			last
				.filter((e) => e.type === 'body')
				.reduce((n, e) => n + (e.type === 'body' ? e.data.length : 0), 0),
		).toBe(1);
	});

	test('a delimiter-looking text after a long line is not a delimiter', () => {
		const head = 'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\n';
		const body = `${'x'.repeat(50)}--b--\r\nafter\r\n--b--\r\n`;
		const message = parseMessage(head + body, { maxLineBytes: 16 });
		expect(message.children[0]?.text).toBe(`${'x'.repeat(50)}--b--\r\nafter`);
	});

	test('refuses a header block over maxHeaderBytes', () => {
		const parser = new MimeParser({ maxHeaderBytes: 100 });
		expect(() =>
			parser.write(new TextEncoder().encode(`Subject: ${'x'.repeat(200)}\r\n`)),
		).toThrow(MimeError);
		const unterminated = new MimeParser({ maxHeaderBytes: 100 });
		expect(() => unterminated.write(new Uint8Array(200).fill(0x61))).toThrow(
			'The header block of part "" is larger than 100 bytes',
		);
	});

	test('cannot be written after it ended', () => {
		const parser = new MimeParser();
		parser.end();
		expect(() => parser.write(new Uint8Array(1))).toThrow(
			'the parser has ended',
		);
	});
});

describe('parseMimeStream', () => {
	test('reads a ReadableStream', async () => {
		const stream = new Blob([MESSAGE]).stream();
		const events: MimeEvent[] = [];
		for await (const event of parseMimeStream(stream)) events.push(event);
		const parser = new MimeParser();
		expect(summary(events)).toEqual(
			summary([...parser.write(MESSAGE), ...parser.end()]),
		);
	});
});
