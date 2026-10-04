import { describe, expect, test } from 'bun:test';
import { type Item, page } from './paging';

const item = (id: string, modseq: number): Item => ({
	id,
	modseq,
	kind: 'updated',
});

describe('page', () => {
	const account = { modseq: 9, floor: 0 };
	const all = [item('a', 1), item('b', 2), item('c', 2), item('d', 5)];

	test('the items a store cut in its database page as all of them would', () => {
		// Up to the key of the item past the limit: what a database sends.
		const sent = all.filter((i) => i.modseq <= 2);
		expect(page(account, [...sent], 2, true)).toEqual(
			page(account, [...all], 2),
		);
		expect(page(account, [...sent], 2, true)).toMatchObject({
			modseq: 1,
			hasMore: true,
		});
	});

	test('items left out mean more, even when every item sent fits the page', () => {
		const sent = all.filter((i) => i.modseq <= 2);
		expect(page(account, [...sent], 1, true)).toEqual({
			items: [item('a', 1)],
			modseq: 1,
			hasMore: true,
		});
		expect(page(account, all.slice(0, 3), 3, true)).toEqual({
			items: all.slice(0, 3),
			modseq: 2,
			hasMore: true,
		});
	});
});
