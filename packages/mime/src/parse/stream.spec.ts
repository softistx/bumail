import { describe, expect, test } from 'bun:test';
import { MimeError } from '../errors';
import { parseMimeStream } from './message';
import { MimeParser } from './stream';
import type { MimeEvent } from './types';

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

	test('one body event per part per write, however many lines', () => {
		const parser = new MimeParser();
		parser.write(new TextEncoder().encode('Subject: lines\r\n\r\n'));
		const events = parser.write(new Uint8Array(1 << 20).fill(0x0a));
		expect(events).toHaveLength(1);
		expect(events[0]?.type === 'body' && events[0].data.length).toBe(
			(1 << 20) - 1,
		);
	});

	test('1-byte chunks through nested parts closed by the outer delimiter', () => {
		const text = new TextEncoder().encode(
			'Content-Type: multipart/mixed; boundary=o\r\n\r\n--o\r\nContent-Type: multipart/alternative; boundary=i\r\n\r\n--i\r\n\r\ninner\r\n--o\r\n\r\nnext\r\n--o--\r\n',
		);
		const parser = new MimeParser();
		const events: MimeEvent[] = [];
		for (let i = 0; i < text.length; i++)
			events.push(...parser.write(text.subarray(i, i + 1)));
		events.push(...parser.end());
		expect(summary(events)).toEqual([
			'headers ',
			'headers 1',
			'headers 1.1',
			'body 1.1:inner',
			'end 1.1',
			'end 1',
			'headers 2',
			'body 2:next',
			'end 2',
			'end ',
		]);
	});

	test('the caller may reuse its buffer once write returns', () => {
		const parser = new MimeParser();
		const buffer = new TextEncoder().encode('Subject: x\r\n\r\nabc\r\n');
		const events = parser.write(buffer);
		buffer.fill(0x21);
		events.push(...parser.end());
		expect(summary(events)).toEqual(['headers ', 'body :abc\r\n', 'end ']);
	});

	test('limits must be integers, and a line long enough for a delimiter', () => {
		expect(() => new MimeParser({ maxHeaderBytes: Number.NaN })).toThrow(
			'MimeParser: maxHeaderBytes must be an integer of at least 1, not NaN',
		);
		expect(() => new MimeParser({ maxDepth: -1 })).toThrow('maxDepth');
		expect(() => new MimeParser({ maxLineBytes: 8 })).toThrow(
			'maxLineBytes must be an integer of at least 1000',
		);
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
		const body = `${'x'.repeat(3000)}--b--\r\nafter\r\n--b--\r\n`;
		const parser = new MimeParser({ maxLineBytes: 1000 });
		const bytes = new TextEncoder().encode(head + body);
		const events: MimeEvent[] = [];
		for (let i = 0; i < bytes.length; i += 1500)
			events.push(...parser.write(bytes.subarray(i, i + 1500)));
		events.push(...parser.end());
		expect(summary(events)).toEqual([
			'headers ',
			'headers 1',
			`body 1:${'x'.repeat(3000)}--b--\r\nafter`,
			'end 1',
			'end ',
		]);
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
