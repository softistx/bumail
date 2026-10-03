import { afterEach, describe, expect, test } from 'bun:test';
import { type MailStore, StoreError } from '@bumail/store';
import { type Harness, harness, SIMPLE, STORES } from '../server/app.fixtures';

async function upload(h: Harness): Promise<string> {
	const response = await h.fetch(`/jmap/upload/${h.alice.id}`, {
		method: 'POST',
		body: SIMPLE,
	});
	return ((await response.json()) as { blobId: string }).blobId;
}

/** The store, but every `linkMessages` throws `error`. */
const failingLinks = (error: Error) => (store: MailStore) =>
	new Proxy(store, {
		get(target, key, receiver) {
			if (key === 'linkMessages') return async () => Promise.reject(error);
			const value = Reflect.get(target, key, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});

const stored = async (h: Harness) =>
	(await h.store.listAccountMessages(h.alice.id, {})).total;

describe.each(STORES)(
	'Email/import and Email/set create on the %s store',
	(kind) => {
		let h: Harness;
		afterEach(() => h.close());

		test('a mailbox the account does not have leaves no email behind', async () => {
			h = await harness(kind);
			const blobId = await upload(h);
			const mailboxIds = { [h.inbox.id]: true, [h.bobInbox.id]: true };
			const imported = await h.call('Email/import', {
				emails: { k: { blobId, mailboxIds } },
			});
			expect(imported.args.notCreated.k).toEqual({
				type: 'invalidProperties',
				description: 'mailboxIds names a mailbox the account does not have',
				properties: ['mailboxIds'],
			});
			const created = await h.call('Email/set', {
				create: {
					k: { blobId, mailboxIds: { [h.inbox.id]: true, nope: true } },
				},
			});
			expect(created.args.notCreated.k.type).toBe('invalidProperties');
			expect(await stored(h)).toBe(0);
		});

		test('every entry is checked before any is imported', async () => {
			h = await harness(kind);
			const blobId = await upload(h);
			const { args } = await h.call('Email/import', {
				emails: {
					a: { blobId, mailboxIds: { [h.inbox.id]: true } },
					'not an id': { blobId, mailboxIds: { [h.inbox.id]: true } },
				},
			});
			expect(args.type).toBe('invalidArguments');
			const second = await h.call('Email/import', {
				emails: { a: { blobId, mailboxIds: { [h.inbox.id]: true } }, b: 1 },
			});
			expect(second.args.type).toBe('invalidArguments');
			expect(await stored(h)).toBe(0);
		});

		test('an email whose second mailbox fails to link is destroyed', async () => {
			const twice = async (h: Harness) => ({
				blobId: await upload(h),
				mailboxIds: { [h.inbox.id]: true, [h.archive.id]: true },
			});
			h = await harness(kind, {}, failingLinks(new Error('disk full')));
			let entry = await twice(h);
			const failed = await h.call('Email/import', { emails: { k: entry } });
			expect(failed.args.type).toBe('serverFail');
			expect(await stored(h)).toBe(0);
			await h.close();
			const gone = new StoreError('NOT_FOUND', 'No such mailbox');
			h = await harness(kind, {}, failingLinks(gone));
			entry = await twice(h);
			const refused = await h.call('Email/import', { emails: { k: entry } });
			expect(refused.args.notCreated.k.type).toBe('invalidProperties');
			expect(await stored(h)).toBe(0);
		});

		test('emails holds at most maxObjectsInSet entries', async () => {
			h = await harness(kind, { limits: { maxObjectsInSet: 2 } });
			const blobId = await upload(h);
			const entry = { blobId, mailboxIds: { [h.inbox.id]: true } };
			const { args } = await h.call('Email/import', {
				emails: { a: entry, b: entry, c: entry },
			});
			expect(args).toMatchObject({
				type: 'requestTooLarge',
				description: 'emails holds more than 2 emails',
			});
			expect(await stored(h)).toBe(0);
		});
	},
);
