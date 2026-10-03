import { describe, expect, test } from 'bun:test';
import { LineReader, literalMarker, type ReaderEvent } from './reader';

const bytes = (text: string) => new TextEncoder().encode(text);

function drain(reader: LineReader): ReaderEvent[] {
	const events: ReaderEvent[] = [];
	for (let event = reader.next(); event; event = reader.next()) {
		events.push(event);
	}
	return events;
}

describe('literalMarker', () => {
	test('{n} waits for a continuation, {n+} does not (RFC 7888)', () => {
		expect(literalMarker('A1 LOGIN {5}')).toEqual({ size: 5, sync: true });
		expect(literalMarker('A1 LOGIN {5+}')).toEqual({ size: 5, sync: false });
		expect(literalMarker('A1 LOGIN {05}')).toEqual({ size: 5, sync: true });
	});

	test('no marker: no braces, no digits, too many digits', () => {
		expect(literalMarker('A1 NOOP')).toBeUndefined();
		expect(literalMarker('A1 X {}')).toBeUndefined();
		expect(literalMarker('A1 X {+}')).toBeUndefined();
		expect(literalMarker('A1 X 5}')).toBeUndefined();
		expect(literalMarker('A1 X {12345678901}')).toBeUndefined();
	});

	test('a 1 GB literal is read as its size, nothing more', () => {
		expect(literalMarker('A1 APPEND INBOX {1073741824}')).toEqual({
			size: 1073741824,
			sync: true,
		});
	});
});

describe('LineReader', () => {
	test('lines end in CRLF or LF, and may come in pieces', () => {
		const reader = new LineReader(100);
		reader.push(bytes('A1 NO'));
		expect(drain(reader)).toEqual([]);
		reader.push(bytes('OP\r\nA2 NOOP\nA3'));
		expect(drain(reader)).toEqual([
			{ type: 'line', text: 'A1 NOOP' },
			{ type: 'line', text: 'A2 NOOP' },
		]);
	});

	test('a literal is handed over as data once asked for', () => {
		const reader = new LineReader(100);
		reader.push(bytes('A1 LOGIN {5}\r\nalice {3}\r\npw!\r\n'));
		expect(reader.next()).toEqual({
			type: 'line',
			text: 'A1 LOGIN {5}',
			literal: { size: 5, sync: true },
		});
		reader.expectLiteral(5);
		const data = reader.next() as Extract<ReaderEvent, { type: 'data' }>;
		expect(new TextDecoder().decode(data.bytes)).toBe('alice');
		expect(data.last).toBe(true);
		expect(reader.next()).toMatchObject({ type: 'line', text: ' {3}' });
	});

	test('a literal may hold CRLF and come in several pieces', () => {
		const reader = new LineReader(100);
		reader.expectLiteral(6);
		reader.push(bytes('a\r\n'));
		expect(reader.next()).toMatchObject({ type: 'data', last: false });
		reader.push(bytes('b\r\n)\r\n'));
		expect(reader.next()).toMatchObject({ type: 'data', last: true });
		expect(reader.next()).toEqual({ type: 'line', text: ')' });
	});

	test('a line past the limit is skipped to its end and reported once, with its tag and marker', () => {
		const reader = new LineReader(32);
		reader.push(bytes(`A9 SEARCH ${'x'.repeat(100)}`));
		expect(drain(reader)).toEqual([]);
		reader.push(bytes(`${'y'.repeat(10_000)} {10+}\r\nA10 NOOP\r\n`));
		const [skipped, next] = drain(reader);
		expect(skipped).toMatchObject({
			type: 'too-long',
			literal: { size: 10, sync: false },
		});
		expect((skipped as { head: string }).head).toStartWith('A9 SEARCH');
		expect(next).toEqual({ type: 'line', text: 'A10 NOOP' });
	});

	test('a million-element sequence set holds only the line limit in memory', () => {
		const reader = new LineReader(65_536);
		const set = Array.from({ length: 1_000_000 }, (_, i) => i + 1).join(',');
		const started = performance.now();
		reader.push(bytes(`A1 FETCH ${set} FLAGS\r\n`));
		const events = drain(reader);
		expect(events).toHaveLength(1);
		expect(events[0]?.type).toBe('too-long');
		expect(performance.now() - started).toBeLessThan(1000);
	});

	test('clear forgets a partial line and a pending literal', () => {
		const reader = new LineReader(100);
		reader.expectLiteral(10);
		reader.push(bytes('abc'));
		reader.clear();
		reader.push(bytes('A1 NOOP\r\n'));
		expect(drain(reader)).toEqual([{ type: 'line', text: 'A1 NOOP' }]);
	});
});
