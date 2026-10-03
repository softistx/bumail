import { afterEach, describe, expect, test } from 'bun:test';
import type { Message } from '@bumail/store';
import { type Harness, harness, SIMPLE, STORES } from '../server/app.fixtures';
import { test as matches } from './filter';
import { keywordsOf } from './keywords';
import { flagChangeOf } from './patch';
import type { Candidate } from './search';

/** Keywords as a store may keep them: in the case they were first written with. */
const MIXED = ['$Forwarded', '$MDNSent', 'Custom', '\\Seen'];

/** The flags, lowercased and sorted: what holds whether the store kept the case or not. */
const folded = (flags: readonly string[] | undefined) =>
	(flags ?? []).map((flag) => flag.toLowerCase()).sort();

const messageWith = (flags: string[]) => ({ flags }) as unknown as Message;

describe('keywords in any case (RFC 8621 §4.1.1)', () => {
	test('keywordsOf lowercases keywords and gives one key for flags that differ only by case', () => {
		expect(
			keywordsOf(['$Forwarded', '$forwarded', '$MDNSent', 'Custom', '\\Seen']),
		).toEqual({
			$forwarded: true,
			$mdnsent: true,
			custom: true,
			$seen: true,
		});
		expect(keywordsOf(['\\Deleted', '\\Flagged'])).toEqual({ $flagged: true });
	});

	test('hasKeyword and notKeyword match a stored keyword without case', async () => {
		const candidate = {
			message: {
				...messageWith(MIXED),
				receivedAt: new Date(0),
				mailboxes: [],
			},
		} as unknown as Candidate;
		expect(await matches({ hasKeyword: '$forwarded' }, candidate)).toBe(true);
		expect(await matches({ hasKeyword: 'custom' }, candidate)).toBe(true);
		expect(await matches({ notKeyword: '$mdnsent' }, candidate)).toBe(false);
		expect(await matches({ notKeyword: '$junk' }, candidate)).toBe(true);
	});

	test('a patch removes the stored spelling and adds nothing already there', () => {
		const message = messageWith(MIXED);
		expect(
			flagChangeOf(
				{ add: ['$forwarded', '$junk'], remove: ['custom'] },
				message,
			),
		).toEqual({ add: ['$junk'], remove: ['custom', 'Custom'] });
		expect(
			flagChangeOf(
				{ set: ['$mdnsent', '$junk', '$MDNSENT'], add: [], remove: [] },
				{
					...message,
					flags: [...MIXED, '\\Deleted'],
				},
			),
		).toEqual({ set: ['$MDNSent', '$junk', '\\Deleted'] });
	});
});

describe.each(STORES)('Mixed-case keywords on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	const seeded = async () => {
		h = await harness(kind);
		return h.add(SIMPLE, h.inbox.id, MIXED);
	};

	test('Email/get returns them lowercased', async () => {
		const message = await seeded();
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: ['keywords'],
		});
		expect(args.list[0].keywords).toEqual({
			$forwarded: true,
			$mdnsent: true,
			custom: true,
			$seen: true,
		});
	});

	test('Email/query matches them in any case', async () => {
		const message = await seeded();
		const other = await h.add(SIMPLE);
		const ids = async (filter: Record<string, string>) =>
			(await h.call('Email/query', { filter })).args.ids;
		expect(await ids({ hasKeyword: '$forwarded' })).toEqual([message.id]);
		expect(await ids({ hasKeyword: '$FORWARDED' })).toEqual([message.id]);
		expect(await ids({ hasKeyword: 'custom' })).toEqual([message.id]);
		expect(await ids({ notKeyword: '$mdnsent' })).toEqual([other.id]);
	});

	test('Email/set adds, removes and sets them without case or duplicates', async () => {
		const message = await seeded();
		const flags = async () =>
			(await h.store.getMessage(h.alice.id, message.id))?.flags;
		await h.call('Email/set', {
			update: {
				[message.id]: {
					'keywords/$forwarded': true,
					'keywords/CUSTOM': true,
					'keywords/$mdnsent': null,
				},
			},
		});
		expect(folded(await flags())).toEqual(['$forwarded', '\\seen', 'custom']);
		await h.call('Email/set', {
			update: { [message.id]: { 'keywords/$Forwarded': null } },
		});
		expect(folded(await flags())).toEqual(['\\seen', 'custom']);
		await h.call('Email/set', {
			update: {
				[message.id]: { keywords: { custom: true, $Junk: true, $junk: true } },
			},
		});
		expect(folded(await flags())).toEqual(['$junk', 'custom']);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: ['keywords'],
		});
		expect(args.list[0].keywords).toEqual({ $junk: true, custom: true });
	});
});
