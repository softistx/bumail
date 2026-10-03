import { describe, expect, test } from 'bun:test';
import { DataReader } from './data';
import { DataWriter } from './data-writer';

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const bytes = (value: string) => new TextEncoder().encode(value);

/** Writes the chunks, then the end, as one text. */
function written(chunks: string[], normalize = false) {
	const writer = new DataWriter(normalize);
	const out = chunks.map((chunk) => text(writer.write(bytes(chunk)))).join('');
	return { out: out + text(writer.end()), writer };
}

describe('DataWriter (RFC 5321 §4.5.2)', () => {
	test('a dot that starts a line is doubled; the message ends with CRLF . CRLF', () => {
		expect(written(['.a\r\nb.\r\n..\r\n.\r\n']).out).toBe(
			'..a\r\nb.\r\n...\r\n..\r\n.\r\n',
		);
	});

	test('whatever the chunks: a CRLF or a line start split between two', () => {
		expect(written(['a\r', '\n.b\r', '\n', '.']).out).toBe(
			'a\r\n..b\r\n..\r\n.\r\n',
		);
	});

	test('a last line without CRLF gets one; an empty message is the dot alone', () => {
		expect(written(['abc']).out).toBe('abc\r\n.\r\n');
		expect(written([]).out).toBe('.\r\n');
	});

	test('a bare CR or LF is counted, or with normalize made CRLF', () => {
		const counted = written(['a\nb\rc\r']);
		expect(counted.writer.bareLineBreaks).toBe(3);
		expect(written(['a\nb\rc\r\r\n.x\n'], true).out).toBe(
			'a\r\nb\r\nc\r\n\r\n..x\r\n.\r\n',
		);
	});

	test('8-bit bytes are noticed', () => {
		expect(written(['abc']).writer.eightBit).toBe(false);
		expect(written(['café']).writer.eightBit).toBe(true);
	});

	test('DataReader reads back what DataWriter wrote', () => {
		const message = '.\r\n..\r\n.hidden\r\n\r\nend\r\n';
		const writer = new DataWriter();
		const wire = new Uint8Array([
			...writer.write(bytes(message)),
			...writer.end(),
		]);
		const chunk = new DataReader().write(wire);
		expect(chunk.done).toBe(true);
		expect(text(chunk.data)).toBe(message);
	});
});
