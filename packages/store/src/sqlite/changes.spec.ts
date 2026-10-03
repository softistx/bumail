import { describe, expect, test } from 'bun:test';
import { rejects, setup } from '../contract/fixtures/setup.fixtures';
import { temporaryStores } from './directories.fixtures';

const { open } = temporaryStores();
const create = () => open();

// The mailbox half of the contract's changes specs, without the message
// that changes a mailbox's counts: that comes with the messages slice.
describe('SqliteMailStore: mailbox changes', () => {
	test('mailboxes: created, renamed, subscribed and deleted', async () => {
		const { store, account, inbox } = await setup(create);
		const start = await store.mailboxChanges(account.id, 0);
		expect(start.created).toEqual([inbox.id]);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, { name: 'B' });
		const middle = await store.mailboxChanges(account.id, start.modseq);
		expect(middle).toMatchObject({
			created: [a.id, b.id],
			updated: [],
			destroyed: [],
		});
		await store.renameMailbox(account.id, a.id, { name: 'A2' });
		await store.setSubscribed(account.id, inbox.id, false);
		await store.deleteMailbox(account.id, b.id);
		const after = await store.mailboxChanges(account.id, middle.modseq);
		expect(after).toMatchObject({ created: [], destroyed: [b.id] });
		expect([...after.updated].sort()).toEqual([a.id, inbox.id].sort());
		expect(after.modseq).toBe(middle.modseq + 3);
	});

	test('one created and deleted since is left out', async () => {
		const { store, account } = await setup(create);
		const { modseq } = await store.mailboxChanges(account.id, 0);
		const gone = await store.createMailbox(account.id, { name: 'Gone' });
		await store.deleteMailbox(account.id, gone.id);
		expect(await store.mailboxChanges(account.id, modseq)).toMatchObject({
			created: [],
			updated: [],
			destroyed: [],
			hasMore: false,
		});
		expect((await store.mailboxChanges(account.id, 0)).destroyed).toEqual([]);
	});

	test('pages of one bring a client to the current state', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, { name: 'B' });
		await store.renameMailbox(account.id, inbox.id, { name: 'Received' });
		const seen = { created: [] as string[], updated: [] as string[] };
		let since = 0;
		for (let more = true; more; ) {
			const page = await store.mailboxChanges(account.id, since, { limit: 1 });
			expect(
				page.created.length + page.updated.length + page.destroyed.length,
			).toBeLessThanOrEqual(1);
			seen.created.push(...page.created);
			seen.updated.push(...page.updated);
			since = page.modseq;
			more = page.hasMore;
		}
		expect(seen.created).toEqual([inbox.id, a.id, b.id]);
		expect(seen.updated).toEqual([inbox.id]);
		expect(since).toBe((await store.mailboxChanges(account.id, 0)).modseq);
	});

	test('a since the account never gave, or a bad limit, is INVALID', async () => {
		const { store, account } = await setup(create);
		const { modseq } = await store.mailboxChanges(account.id, 0);
		await rejects(store.mailboxChanges(account.id, modseq + 1), 'INVALID');
		await rejects(store.mailboxChanges(account.id, -1), 'INVALID');
		await rejects(store.mailboxChanges(account.id, 1.5), 'INVALID');
		await rejects(store.mailboxChanges(account.id, 0, { limit: 0 }), 'INVALID');
	});

	test('accounts count their changes apart', async () => {
		const { store, account } = await setup(create);
		const other = await store.createAccount('john@example.net');
		await store.createMailbox(account.id, { name: 'A' });
		expect(await store.mailboxChanges(other.id, 0)).toMatchObject({
			modseq: 0,
			created: [],
		});
		expect((await store.mailboxChanges(account.id, 0)).modseq).toBe(2);
	});
});
