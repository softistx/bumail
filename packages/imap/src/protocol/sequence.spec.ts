import { describe, expect, test } from 'bun:test';
import {
	formatSequenceSet,
	parseSequenceSet,
	seqPositions,
	uidPositions,
} from './sequence';

describe('parseSequenceSet (RFC 9051 §9)', () => {
	test('numbers, ranges, * and lists', () => {
		expect(parseSequenceSet('2,4:7,9,12:*')).toEqual([
			{ from: 2, to: 2 },
			{ from: 4, to: 7 },
			{ from: 9, to: 9 },
			{ from: 12, to: '*' },
		]);
		expect(parseSequenceSet('*:4')).toEqual([{ from: '*', to: 4 }]);
	});

	test('what is not a set', () => {
		for (const text of [
			'',
			'0',
			'1,',
			',1',
			'1:',
			'1::2',
			'a',
			'$',
			'4294967296',
			'1 2',
		]) {
			expect(parseSequenceSet(text)).toBeUndefined();
		}
	});
});

describe('seqPositions', () => {
	test('§6.4.8: 2,4:7,9,12:* among 15 messages', () => {
		expect(seqPositions(parseSequenceSet('2,4:7,9,12:*') ?? [], 15)).toEqual([
			1, 3, 4, 5, 6, 8, 11, 12, 13, 14,
		]);
	});

	test('a range in either order, overlaps counted once', () => {
		expect(seqPositions(parseSequenceSet('3:1,2,1:2') ?? [], 3)).toEqual([
			0, 1, 2,
		]);
	});

	test('a number past the last message, or any number in an empty mailbox, is refused', () => {
		expect(seqPositions(parseSequenceSet('4') ?? [], 3)).toBeUndefined();
		expect(seqPositions(parseSequenceSet('1:*') ?? [], 0)).toBeUndefined();
	});
});

describe('uidPositions', () => {
	const uids = [3, 7, 8, 20];

	test('UIDs that name no message are skipped', () => {
		expect(uidPositions(parseSequenceSet('1:7,19:21') ?? [], uids)).toEqual([
			0, 1, 3,
		]);
	});

	test('n:* names the last message even past it (§6.4.8)', () => {
		expect(uidPositions(parseSequenceSet('100:*') ?? [], uids)).toEqual([3]);
	});

	test('1:4294967295 takes no longer than the messages it names', () => {
		const started = performance.now();
		expect(uidPositions(parseSequenceSet('1:4294967295') ?? [], uids)).toEqual([
			0, 1, 2, 3,
		]);
		expect(performance.now() - started).toBeLessThan(50);
	});

	test('an empty mailbox: nothing', () => {
		expect(uidPositions(parseSequenceSet('1:*') ?? [], [])).toEqual([]);
	});
});

describe('formatSequenceSet', () => {
	test('runs become ranges', () => {
		expect(formatSequenceSet([1, 2, 3, 5, 7, 8, 9])).toBe('1:3,5,7:9');
		expect(formatSequenceSet([])).toBe('');
	});
});
