import { describe, expect, test } from 'bun:test';
import { MethodError } from './errors';
import { jsonExcess } from './json';
import { pageOf } from './query';
import { pointer, resolveReferences } from './refs';
import type { Invocation } from './request';

const RESULT = {
	list: [
		{ id: 'e1', threadId: 't1', emailIds: ['e1', 'e2'] },
		{ id: 'e3', threadId: 't2', emailIds: ['e3'] },
	],
	'a/b': { 'm~n': 7 },
};

describe('RFC 8620 §3.7 back-references', () => {
	test('/list/*/threadId maps over the list', () => {
		expect(pointer(RESULT, '/list/*/threadId', 100)).toEqual(['t1', 't2']);
	});

	test('an array of arrays is flattened once', () => {
		expect(pointer(RESULT, '/list/*/emailIds', 100)).toEqual([
			'e1',
			'e2',
			'e3',
		]);
	});

	test('RFC 6901: ~1 is /, ~0 is ~, and an index reads an array', () => {
		expect(pointer(RESULT, '/a~1b/m~0n', 100)).toBe(7);
		expect(pointer(RESULT, '/list/1/id', 100)).toBe('e3');
	});

	test('a path that names nothing is invalidResultReference', () => {
		for (const path of [
			'/nothing',
			'/list/2/id',
			'/list/01',
			'list',
			'/list/*/x',
		]) {
			expect(() => pointer(RESULT, path, 100)).toThrow(MethodError);
		}
	});

	test('the expansion is capped', () => {
		const many = { ids: Array.from({ length: 11 }, (_, i) => `i${i}`) };
		expect(() => pointer(many, '/ids', 10)).toThrow('more than 10 values');
		expect(() => pointer({ list: [many, many] }, '/list/*/ids', 15)).toThrow(
			'more than 15',
		);
	});

	test('#ids is resolved from the call with that id and name', () => {
		const responses: Invocation[] = [
			['Email/query', { ids: ['a', 'b'] }, 't0'],
		];
		const ref = { resultOf: 't0', name: 'Email/query', path: '/ids' };
		expect(
			resolveReferences({ accountId: 'x', '#ids': ref }, responses, 10),
		).toEqual({ accountId: 'x', ids: ['a', 'b'] });
		const type = (args: Record<string, unknown>) => {
			try {
				resolveReferences(args, responses, 10);
			} catch (error) {
				return (error as MethodError).type;
			}
			return undefined;
		};
		expect(type({ '#ids': { ...ref, name: 'Email/get' } })).toBe(
			'invalidResultReference',
		);
		expect(type({ '#ids': { ...ref, resultOf: 'nope' } })).toBe(
			'invalidResultReference',
		);
		expect(type({ '#ids': 'not a reference' })).toBe('invalidResultReference');
		expect(type({ ids: [], '#ids': ref })).toBe('invalidArguments');
	});
});

describe('the JSON guard', () => {
	test('counts depth and tokens without parsing', () => {
		expect(jsonExcess('{"a":[1,2,{"b":"c\\"]]]"}]}', 3, 100)).toBeUndefined();
		expect(jsonExcess('[[[[1]]]]', 3, 100)).toBe('depth');
		expect(jsonExcess('[1,2,3,4,5]', 10, 5)).toBe('tokens');
		expect(jsonExcess('"]]]]]]]]"', 1, 10)).toBeUndefined();
	});
});

describe('RFC 8620 §5.5 query paging', () => {
	const ids = ['a', 'b', 'c', 'd', 'e'];

	test('position, a negative position, an anchor with an offset, and the total', () => {
		expect(pageOf(ids, { position: 1, limit: 2 }, 10)).toEqual({
			position: 1,
			ids: ['b', 'c'],
		});
		expect(pageOf(ids, { position: -2 }, 10)).toEqual({
			position: 3,
			ids: ['d', 'e'],
		});
		expect(pageOf(ids, { position: -9 }, 10)).toEqual({ position: 0, ids });
		expect(
			pageOf(ids, { anchor: 'c', anchorOffset: -1, limit: 1 }, 10),
		).toEqual({ position: 1, ids: ['b'] });
		expect(pageOf(ids, { calculateTotal: true, position: 9 }, 10)).toEqual({
			position: 9,
			ids: [],
			total: 5,
		});
	});

	test('a limit clamped to the maximum is returned', () => {
		expect(pageOf(ids, { limit: 50 }, 3)).toEqual({
			position: 0,
			ids: ['a', 'b', 'c'],
			limit: 3,
		});
		expect(pageOf(ids, {}, 3)).toEqual({
			position: 0,
			ids: ['a', 'b', 'c'],
			limit: 3,
		});
		expect(pageOf(ids, {}, 10)).toEqual({ position: 0, ids });
	});
});
