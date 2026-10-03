import { describe, expect, test } from 'bun:test';
import {
	colonList,
	decodeBase64Strict,
	parseTagList,
	withoutFws,
} from './tags';

describe('parseTagList (RFC 6376 §3.2)', () => {
	test('trims folding white space around names and values, keeps it inside', () => {
		const parsed = parseTagList(' v = 1 ;\r\n\th=from : to;\tz=a b;');
		expect(parsed).toEqual({
			tags: new Map([
				['v', '1'],
				['h', 'from : to'],
				['z', 'a b'],
			]),
		});
	});

	test('names are case-sensitive, and a value may be empty', () => {
		expect(parseTagList('a=1; A=2; p=')).toEqual({
			tags: new Map([
				['a', '1'],
				['A', '2'],
				['p', ''],
			]),
		});
	});

	test('refuses a duplicate, a tag without "=", a bad name, and an empty tag', () => {
		expect(parseTagList('a=1; a=2')).toEqual({ error: 'duplicate tag a=' });
		expect(parseTagList('a=1; b')).toEqual({
			error: 'malformed tag list: "b" has no "="',
		});
		expect(parseTagList('_a=1')).toEqual({
			error: 'malformed tag list: "_a" is not a tag name',
		});
		expect(parseTagList(';a=1')).toEqual({
			error: 'malformed tag list: an empty tag',
		});
		expect(parseTagList(`${'x'.repeat(100)}`)).toEqual({
			error: `malformed tag list: "${'x'.repeat(40)}…" has no "="`,
		});
	});
});

describe('values', () => {
	test('withoutFws and colonList', () => {
		expect(withoutFws('ab\r\n cd\tef')).toBe('abcdef');
		expect(colonList('from : to:subject')).toEqual(['from', 'to', 'subject']);
	});

	test('decodeBase64Strict takes canonical base64 only', () => {
		expect(decodeBase64Strict('AQID')).toEqual(new Uint8Array([1, 2, 3]));
		expect(decodeBase64Strict('AQI=')).toEqual(new Uint8Array([1, 2]));
		expect(decodeBase64Strict('')).toEqual(new Uint8Array());
		for (const bad of ['AQI', 'AQ==AQ==', 'A-_B', 'AQID=']) {
			expect(decodeBase64Strict(bad)).toBeUndefined();
		}
	});
});
