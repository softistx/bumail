import { describe, expect, test } from 'bun:test';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeChanges(create: CreateStore): void {
	describe('changes', () => {
		messages(create);
		fromZero(create);
		paging(create);
		mailboxes(create);
	});
}

function messages(create: CreateStore): void {
	test('RFC 8620 §5.2: created, updated and destroyed since a modseq', async () => {
		const { store, account, inbox } = await setup(create);
		const kept = await store.addMessage(account.id, inbox.id, {
			content: bytes('kept'),
		});
		const gone = await store.addMessage(account.id, inbox.id, {
			content: bytes('gone'),
		});
		const start = await store.messageChanges(account.id, 0);
		expect(start).toMatchObject({
			created: [kept.id, gone.id],
			updated: [],
			destroyed: [],
			hasMore: false,
		});
		const added = await store.addMessage(account.id, inbox.id, {
			content: bytes('new'),
		});
		await store.setFlags(account.id, [kept.id], { add: ['\\Seen'] });
		const {
			expunged: [expunged],
		} = await store.destroyMessages(account.id, [gone.id]);
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

	test('a message created and destroyed since is left out, its UID expunged', async () => {
		const { store, account, inbox } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		const brief = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
		});
		const destroyed = await store.destroyMessages(account.id, [brief.id]);
		const changes = await store.messageChanges(account.id, modseq);
		expect([
			...changes.created,
			...changes.updated,
			...changes.destroyed,
		]).toEqual([]);
		// Its UID is still reported gone (RFC 7162 §3.2.6).
		expect(destroyed.expunged).toMatchObject([{ mailboxId: inbox.id }]);
		expect(changes.expunged).toEqual(destroyed.expunged);
	});

	test('RFC 7162 §3.2.6: a UID that came and went since is still expunged', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const old = await store.addMessage(account.id, inbox.id, {
			content: bytes('old'),
		});
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.linkMessages(account.id, [old.id], a.id);
		const removed = await store.removeMessages(account.id, [old.id], a.id);
		const changes = await store.messageChanges(account.id, modseq);
		expect(removed.expunged).toMatchObject([{ mailboxId: a.id }]);
		expect(changes.expunged).toEqual(removed.expunged);
		expect(changes.updated).toEqual([old.id]);
	});
}

function fromZero(create: CreateStore): void {
	test('since 0 is the whole state: every message created, nothing destroyed', async () => {
		const { store, account, inbox } = await setup(create);
		const kept = await store.addMessage(account.id, inbox.id, {
			content: bytes('a'),
		});
		const gone = await store.addMessage(account.id, inbox.id, {
			content: bytes('b'),
		});
		await store.removeMessages(account.id, [gone.id], inbox.id);
		expect(await store.messageChanges(account.id, 0)).toMatchObject({
			created: [kept.id],
			updated: [],
			destroyed: [],
			expunged: [],
		});
	});
}

function paging(create: CreateStore): void {
	test('limit cuts the answer, and hasMore asks for the rest', async () => {
		const { store, account, inbox } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		const ids: string[] = [];
		for (const text of ['a', 'b', 'c'])
			ids.push(
				(await store.addMessage(account.id, inbox.id, { content: bytes(text) }))
					.id,
			);
		const first = await store.messageChanges(account.id, modseq, {
			limit: 2,
		});
		expect(first).toMatchObject({ created: ids.slice(0, 2), hasMore: true });
		const rest = await store.messageChanges(account.id, first.modseq, {
			limit: 2,
		});
		expect(rest).toMatchObject({ created: ids.slice(2), hasMore: false });
		await rejects(store.messageChanges(account.id, 0, { limit: 0 }), 'INVALID');
	});

	test('RFC 8620 §5.2: a page lists a message as created even when it changed again later', async () => {
		const { store, account, inbox } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		const a = await store.addMessage(account.id, inbox.id, {
			content: bytes('a'),
		});
		const b = await store.addMessage(account.id, inbox.id, {
			content: bytes('b'),
		});
		const c = await store.addMessage(account.id, inbox.id, {
			content: bytes('c'),
		});
		await store.setFlags(account.id, [a.id], { add: ['\\Seen'] });
		const seen = { created: [] as string[], updated: [] as string[] };
		let since = modseq;
		for (let more = true; more; ) {
			const page = await store.messageChanges(account.id, since, {
				limit: 1,
			});
			seen.created.push(...page.created);
			seen.updated.push(...page.updated);
			since = page.modseq;
			more = page.hasMore;
		}
		expect(seen.created).toEqual([a.id, b.id, c.id]);
		expect(seen.updated).toEqual([a.id]);
	});

	test('a since the account never gave is INVALID', async () => {
		const { store, account } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		await rejects(store.messageChanges(account.id, modseq + 1), 'INVALID');
		await rejects(store.messageChanges(account.id, -1), 'INVALID');
		await rejects(store.mailboxChanges(account.id, 1.5), 'INVALID');
	});
}

function mailboxes(create: CreateStore): void {
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
		await store.renameMailbox(account.id, a.id, { name: 'A2' });
		await store.addMessage(account.id, inbox.id, { content: bytes('x') });
		await store.deleteMailbox(account.id, b.id);
		const after = await store.mailboxChanges(account.id, middle.modseq);
		expect(after).toMatchObject({ created: [], destroyed: [b.id] });
		expect([...after.updated].sort()).toEqual([a.id, inbox.id].sort());
	});

	test('mailboxes changed at one modseq come in the order they were created', async () => {
		const { store, account, inbox } = await setup(create);
		// Created Z, then A: their names sort the other way.
		const z = await store.createMailbox(account.id, { name: 'Z' });
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(account.id, z.id, {
			content: bytes('x'),
		});
		const { modseq } = await store.mailboxChanges(account.id, 0);
		// A move changes both mailboxes at one modseq.
		await store.moveMessages(account.id, [message.id], z.id, a.id);
		const changes = await store.mailboxChanges(account.id, modseq);
		expect(changes.updated).toEqual([z.id, a.id]);
		expect(changes.updated).not.toContain(inbox.id);
	});

	test('accounts count their changes apart', async () => {
		const { store, account, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		await store.addMessage(account.id, inbox.id, { content: bytes('x') });
		expect(await store.messageChanges(other.id, 0)).toMatchObject({
			modseq: 0,
			created: [],
		});
		expect((await store.messageChanges(account.id, 0)).modseq).toBeGreaterThan(
			0,
		);
	});
}
