import { describe, expect, test } from 'bun:test';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeChanges(create: CreateStore): void {
	describe('changes', () => {
		test('RFC 8620 §5.2: created, updated and destroyed since a modseq', async () => {
			const { store, account, inbox } = await setup(create);
			const kept = await store.addMessage(inbox.id, { content: bytes('kept') });
			const gone = await store.addMessage(inbox.id, { content: bytes('gone') });
			const start = await store.messageChanges(account.id, 0);
			expect(start).toMatchObject({
				created: [kept.id, gone.id],
				updated: [],
				destroyed: [],
				hasMore: false,
			});
			const added = await store.addMessage(inbox.id, { content: bytes('new') });
			await store.setFlags([kept.id], { add: ['\\Seen'] });
			const [expunged] = await store.destroyMessages([gone.id]);
			const changes = await store.messageChanges(account.id, start.modseq);
			expect(changes).toMatchObject({
				created: [added.id],
				updated: [kept.id],
				destroyed: [gone.id],
				expunged: [expunged],
				hasMore: false,
			});
			expect(changes.modseq).toBe(expunged?.modseq as number);
			const none = await store.messageChanges(account.id, changes.modseq);
			expect(none).toMatchObject({
				created: [],
				updated: [],
				destroyed: [],
				expunged: [],
			});
		});

		test('a message created and destroyed since is left out', async () => {
			const { store, account, inbox } = await setup(create);
			const { modseq } = await store.messageChanges(account.id, 0);
			const brief = await store.addMessage(inbox.id, { content: bytes('x') });
			await store.destroyMessages([brief.id]);
			const changes = await store.messageChanges(account.id, modseq);
			expect([
				...changes.created,
				...changes.updated,
				...changes.destroyed,
			]).toEqual([]);
		});

		test('limit cuts the answer, and hasMore asks for the rest', async () => {
			const { store, account, inbox } = await setup(create);
			const { modseq } = await store.messageChanges(account.id, 0);
			const ids: string[] = [];
			for (const text of ['a', 'b', 'c'])
				ids.push(
					(await store.addMessage(inbox.id, { content: bytes(text) })).id,
				);
			const first = await store.messageChanges(account.id, modseq, {
				limit: 2,
			});
			expect(first).toMatchObject({ created: ids.slice(0, 2), hasMore: true });
			const rest = await store.messageChanges(account.id, first.modseq, {
				limit: 2,
			});
			expect(rest).toMatchObject({ created: ids.slice(2), hasMore: false });
			await rejects(
				store.messageChanges(account.id, 0, { limit: 0 }),
				'INVALID',
			);
		});

		test('a since the account never gave is INVALID', async () => {
			const { store, account } = await setup(create);
			const { modseq } = await store.messageChanges(account.id, 0);
			await rejects(store.messageChanges(account.id, modseq + 1), 'INVALID');
			await rejects(store.messageChanges(account.id, -1), 'INVALID');
			await rejects(store.mailboxChanges(account.id, 1.5), 'INVALID');
		});

		test('mailboxes: created, renamed, deleted, and changed by their messages', async () => {
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
			await store.renameMailbox(a.id, 'A2');
			await store.addMessage(inbox.id, { content: bytes('x') });
			await store.deleteMailbox(b.id);
			const after = await store.mailboxChanges(account.id, middle.modseq);
			expect(after).toMatchObject({ created: [], destroyed: [b.id] });
			expect([...after.updated].sort()).toEqual([a.id, inbox.id].sort());
		});

		test('accounts count their changes apart', async () => {
			const { store, account, inbox } = await setup(create);
			const other = await store.createAccount('john@example.net');
			await store.addMessage(inbox.id, { content: bytes('x') });
			expect(await store.messageChanges(other.id, 0)).toMatchObject({
				modseq: 0,
				created: [],
			});
			expect(
				(await store.messageChanges(account.id, 0)).modseq,
			).toBeGreaterThan(0);
		});
	});
}
