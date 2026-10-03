import { describe, expect, test } from 'bun:test';
import { filterHeader, select } from './section';
import { type Entity, StructureScanner, scanStructure } from './structure';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** RFC 9051 §6.4.5's example of part numbers, as a message. */
const NESTED = [
	'Subject: parts',
	'Content-Type: MULTIPART/MIXED; boundary=outer',
	'',
	'--outer',
	'Content-Type: TEXT/PLAIN',
	'',
	'part 1',
	'--outer',
	'Content-Type: APPLICATION/OCTET-STREAM',
	'',
	'part 2',
	'--outer',
	'Content-Type: MESSAGE/RFC822',
	'',
	'Subject: inner',
	'Content-Type: MULTIPART/MIXED; boundary=inner',
	'',
	'--inner',
	'Content-Type: TEXT/PLAIN',
	'',
	'part 3.1',
	'--inner',
	'Content-Type: APPLICATION/OCTET-STREAM',
	'',
	'part 3.2',
	'--inner--',
	'--outer',
	'Content-Type: MULTIPART/MIXED; boundary=four',
	'',
	'--four',
	'Content-Type: IMAGE/GIF',
	'',
	'part 4.1',
	'--four',
	'Content-Type: MESSAGE/RFC822',
	'',
	'Subject: 4.2',
	'',
	'part 4.2.1 body',
	'--four--',
	'--outer--',
	'',
].join('\r\n');

function scan(text: string, chunk = 1 << 20): Entity {
	const bytes = encoder.encode(text);
	const scanner = new StructureScanner();
	for (let at = 0; at < bytes.length; at += chunk)
		scanner.write(bytes.subarray(at, at + chunk));
	return scanner.end();
}

function text(
	message: string,
	section: Parameters<typeof select>[1],
): string | undefined {
	const selection = select(scan(message), section);
	if (!selection) return undefined;
	if ('range' in selection)
		return message.slice(selection.range.start, selection.range.end);
	const block = encoder.encode(
		message.slice(selection.header.start, selection.header.end),
	);
	return decoder.decode(filterHeader(block, selection.fields, selection.not));
}

describe('part numbers (RFC 9051 §6.4.5)', () => {
	test('each part of the example by its number', () => {
		expect(text(NESTED, { path: [1] })).toBe('part 1');
		expect(text(NESTED, { path: [2] })).toBe('part 2');
		expect(text(NESTED, { path: [3, 1] })).toBe('part 3.1');
		expect(text(NESTED, { path: [3, 2] })).toBe('part 3.2');
		expect(text(NESTED, { path: [4, 1] })).toBe('part 4.1');
		expect(text(NESTED, { path: [4, 2, 1] })).toBe('part 4.2.1 body');
	});

	test('HEADER and TEXT of a message/rfc822 part; MIME of any part', () => {
		expect(text(NESTED, { path: [3], text: 'HEADER' })).toStartWith(
			'Subject: inner\r\n',
		);
		expect(text(NESTED, { path: [4, 2], text: 'TEXT' })).toBe(
			'part 4.2.1 body',
		);
		expect(text(NESTED, { path: [2], text: 'MIME' })).toBe(
			'Content-Type: APPLICATION/OCTET-STREAM\r\n\r\n',
		);
		expect(text(NESTED, { path: [1], text: 'HEADER' })).toBeUndefined();
	});

	test('the message part 3 is whole: header and body', () => {
		expect(text(NESTED, { path: [3] })).toStartWith(
			'Subject: inner\r\nContent-Type',
		);
		expect(text(NESTED, { path: [3] })).toEndWith('--inner--');
	});

	test('a message that is not multipart has only a part 1: its body', () => {
		const message = 'Subject: x\r\n\r\nbody\r\n';
		expect(text(message, { path: [1] })).toBe('body\r\n');
		expect(text(message, { path: [2] })).toBeUndefined();
	});

	test('HEADER.FIELDS and .NOT keep whole folded fields, then the blank line', () => {
		const message = 'Subject: a\r\n b\r\nFrom: x@y\r\nTo: z@w\r\n\r\nbody';
		expect(
			text(message, {
				path: [],
				text: 'HEADER.FIELDS',
				fields: ['subject', 'TO'],
			}),
		).toBe('Subject: a\r\n b\r\nTo: z@w\r\n\r\n');
		expect(
			text(message, {
				path: [],
				text: 'HEADER.FIELDS.NOT',
				fields: ['Subject'],
			}),
		).toBe('From: x@y\r\nTo: z@w\r\n\r\n');
	});

	test('the same offsets whatever the chunks', () => {
		const offsets = (root: Entity): number[] => [
			root.start,
			root.bodyStart,
			root.end,
			root.lines,
			...root.children.flatMap(offsets),
			...(root.message ? offsets(root.message) : []),
		];
		const whole = offsets(scan(NESTED));
		for (const chunk of [1, 2, 3, 7, 64])
			expect(offsets(scan(NESTED, chunk))).toEqual(whole);
	});
});

describe('sizes and lines, as BODYSTRUCTURE counts them', () => {
	test('the line break before a delimiter is the delimiter’s', () => {
		const root = scan(
			'Content-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\n\r\na\r\nb\r\n\r\n--b--\r\n',
		);
		const part = root.children[0] as Entity;
		expect(part.end - part.bodyStart).toBe(6);
		expect(part.lines).toBe(2);
	});

	test('a last line without a line break counts', () => {
		const root = scan('Subject: x\r\n\r\none\r\ntwo');
		expect(root.lines).toBe(2);
		expect(root.end - root.bodyStart).toBe(8);
	});

	test('bare LF line endings read like CRLF', () => {
		const root = scan(
			'Content-Type: multipart/mixed; boundary=b\n\n--b\n\nx\n--b--\n',
		);
		expect(root.children).toHaveLength(1);
		expect(
			(root.children[0] as Entity).end - (root.children[0] as Entity).bodyStart,
		).toBe(1);
	});
});

describe('hostile shapes stay bounded', () => {
	test('10 000 nested multiparts: read 32 deep, the rest as a body', () => {
		const depth = 10_000;
		let message = '';
		for (let i = 0; i < depth; i++)
			message += `Content-Type: multipart/mixed; boundary=b${i}\r\n\r\n--b${i}\r\n`;
		const started = performance.now();
		let root = scan(`${message}x\r\n`);
		expect(performance.now() - started).toBeLessThan(2000);
		let levels = 0;
		while (root.children[0]) {
			root = root.children[0];
			levels++;
		}
		expect(levels).toBeLessThanOrEqual(33);
	});

	test('100 000 parts: 1000 kept, the rest read as body text', () => {
		const message = `Content-Type: multipart/mixed; boundary=b\r\n\r\n${'--b\r\n\r\nx\r\n'.repeat(100_000)}--b--\r\n`;
		const root = scan(message);
		expect(root.children).toHaveLength(1000);
	});

	test('a 20 MB line and a 20 MB header are walked, not held', async () => {
		const blob = new Blob([
			`X-Long: ${'a'.repeat(20 << 20)}\r\nSubject: hi\r\n\r\n${'b'.repeat(20 << 20)}`,
		]);
		const root = await scanStructure(blob);
		expect(root.headers.get('subject')).toBe('hi');
		expect(root.end).toBe(blob.size);
	});

	test('headerOnly stops after the message’s own header', async () => {
		const blob = new Blob(['Subject: hi\r\n\r\n', 'x'.repeat(1 << 20)]);
		const root = await scanStructure(blob, true);
		expect(root.bodyStart).toBe(15);
	});
});
