import { describe, expect, test } from 'bun:test';
import { MessageHeaders } from '../headers/fields';
import { parseContentType } from '../headers/parameters';
import { BodyGatherer } from './body';
import { LineAssembler, lineBreakLength } from './lines';
import type { PartInfo } from './types';

const part: PartInfo = {
	path: '',
	headers: new MessageHeaders([]),
	contentType: parseContentType('text/plain'),
};

describe('BodyGatherer', () => {
	test('a million lines of one chunk are one piece, not a million', () => {
		const chunk = new Uint8Array(1 << 20).fill(0x0a);
		const body = new BodyGatherer();
		new LineAssembler().push(chunk, (line) => {
			const content = line.subarray(0, line.length - lineBreakLength(line));
			if (content.length > 0) body.add(part, content);
			body.add(part, line.subarray(content.length));
		});
		expect(body.pieces).toBe(1);
		const event = body.flush();
		expect(event?.type === 'body' && event.data.length).toBe(1 << 20);
	});

	test('the event is a copy: the caller may reuse its chunk', () => {
		const chunk = new TextEncoder().encode('abc');
		const body = new BodyGatherer();
		body.add(part, chunk);
		const event = body.flush();
		chunk.fill(0x78);
		expect(event?.type === 'body' && new TextDecoder().decode(event.data)).toBe(
			'abc',
		);
	});

	test('pieces of different chunks stay apart', () => {
		const body = new BodyGatherer();
		body.add(part, new Uint8Array([1]));
		body.add(part, new Uint8Array([2]));
		expect(body.pieces).toBe(2);
	});
});
