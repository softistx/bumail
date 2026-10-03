import { describe, expect, test } from 'bun:test';
import { DataWriter } from '../protocol/data-writer';
import { parseEhlo } from '../protocol/ehlo';
import { LineSplitter } from '../protocol/lines';
import { ReplyReader } from '../protocol/reply-reader';

/**
 * What a server sends, and what a caller's message holds, is read in one
 * pass: no anchored `[ \t]+$` that retries from each blank of a run. Linear
 * code takes a few milliseconds here; the bound leaves CI a wide margin.
 */
const BOUND_MS = 500;
const PAD = ' \t'.repeat(500_000);

function timed(run: () => void): number {
	const start = performance.now();
	run();
	return performance.now() - start;
}

describe('hostile input takes linear time', () => {
	test('a reply line of a million blanks', () => {
		const reader = new ReplyReader();
		expect(timed(() => reader.line(`250 ${PAD}x`))).toBeLessThan(BOUND_MS);
		expect(timed(() => reader.line(`2.1.0${PAD}`))).toBeLessThan(BOUND_MS);
	});

	test('an EHLO line of a million blanks around its keyword', () => {
		const ms = timed(() =>
			parseEhlo(['greets', `${PAD}AUTH${PAD}PLAIN${PAD}`]),
		);
		expect(ms).toBeLessThan(BOUND_MS);
	});

	test('a reply sent a byte at a time, and lines past MAX_LINE', () => {
		const splitter = new LineSplitter();
		const line = new TextEncoder().encode(`250 ${'x'.repeat(2000)}\r\n`);
		const ms = timed(() => {
			for (let i = 0; i < 50; i++) {
				for (const byte of line) {
					splitter.push(new Uint8Array([byte]));
					while (splitter.next());
				}
			}
			splitter.push(new Uint8Array(4 * 1024 * 1024).fill(0x20));
			expect(splitter.next()).toEqual({ tooLong: true });
		});
		expect(ms).toBeLessThan(BOUND_MS * 4);
	});

	test('a message of 8 MiB of dots, bare CRs and line breaks', () => {
		const message = new TextEncoder().encode('.\r\r\n.\n'.repeat(1_400_000));
		const writer = new DataWriter(true);
		const ms = timed(() => {
			writer.write(message);
			writer.end();
		});
		expect(ms).toBeLessThan(BOUND_MS);
	});
});
