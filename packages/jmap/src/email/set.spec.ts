import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
	STORES,
} from '../server/app.fixtures';

describe.each(STORES)('Email/set and Email/changes on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8621 §4.6: Email/set updates keywords and mailboxIds, whole or patched, and destroys', async () => {
		h = await harness(kind);
		const message = await h.add(SIMPLE, h.inbox.id, ['\\Deleted']);
		const { args } = await h.call('Email/set', {
			update: {
				[message.id]: {
					'keywords/$seen': true,
					'keywords/$flagged': true,
					[`mailboxIds/${h.archive.id}`]: true,
					[`mailboxIds/${h.inbox.id}`]: null,
				},
			},
		});
		expect(args.updated).toEqual({ [message.id]: null });
		let stored = await h.store.getMessage(h.alice.id, message.id);
		expect(stored?.flags).toEqual(['\\Deleted', '\\Flagged', '\\Seen']);
		expect(stored?.mailboxes.map((m) => m.mailboxId)).toEqual([h.archive.id]);
		await h.call('Email/set', {
			update: {
				[message.id]: {
					keywords: { $answered: true },
					mailboxIds: { [h.inbox.id]: true, [h.archive.id]: true },
				},
			},
		});
		stored = await h.store.getMessage(h.alice.id, message.id);
		expect(stored?.flags).toEqual(['\\Answered', '\\Deleted']);
		expect(stored?.mailboxes).toHaveLength(2);
		const refused = await h.call('Email/set', {
			update: { [message.id]: { mailboxIds: {} }, nope: { keywords: {} } },
			destroy: ['gone'],
		});
		expect(refused.args.notUpdated[message.id].type).toBe('invalidProperties');
		expect(refused.args.notUpdated.nope.type).toBe('notFound');
		expect(refused.args.notDestroyed.gone.type).toBe('notFound');
		const mixed = await h.call('Email/set', {
			update: { [message.id]: { keywords: {}, 'keywords/$seen': true } },
		});
		expect(mixed.args.notUpdated[message.id].type).toBe('invalidPatch');
		const destroyed = await h.call('Email/set', { destroy: [message.id] });
		expect(destroyed.args.destroyed).toEqual([message.id]);
		expect(await h.store.getMessage(h.alice.id, message.id)).toBeUndefined();
	});

	test('Email/changes lists created, updated and destroyed emails', async () => {
		h = await harness(kind);
		const kept = await h.add(SIMPLE);
		const gone = await h.add(MULTIPART);
		const since = (await h.call('Email/get', { ids: [] })).args.state;
		const fresh = await h.add(SIMPLE);
		await h.store.setFlags(h.alice.id, [kept.id], { add: ['\\Seen'] });
		await h.store.destroyMessages(h.alice.id, [gone.id]);
		const { args } = await h.call('Email/changes', { sinceState: since });
		expect(args).toMatchObject({
			oldState: since,
			created: [fresh.id],
			updated: [kept.id],
			destroyed: [gone.id],
			hasMoreChanges: false,
		});
		expect(Number(args.newState)).toBeGreaterThan(Number(since));
	});
});
