import { describe, expect, test } from 'bun:test';
import {
	bytes,
	type CreateStore,
	rejects,
	setup,
	textOf,
} from './setup.fixtures';

export function describeMoves(create: CreateStore): void {
	describe('copies, links, moves and removals', () => {
		copyingAndLinking(create);
		moving(create);
		removing(create);
		accounts(create);
	});
}

function copyingAndLinking(create: CreateStore): void {
	test('RFC 9051 §6.4.7: a copy is a new message, sharing the blob, with flags of its own', async () => {
		const { store, account, inbox } = await setup(create);
		const archive = await store.createMailbox(account.id, {
			name: 'Archive',
			role: 'archive',
		});
		const original = await store.addMessage(inbox.id, {
			content: bytes('x'),
			flags: ['\\Seen'],
		});
		const {
			messages: [copy],
			notFound,
		} = await store.copyMessages([original.id, original.id], archive.id);
		expect(notFound).toEqual([]);
		expect(copy?.id).not.toBe(original.id);
		expect(copy).toMatchObject({
			blobId: original.blobId,
			flags: ['\\Seen'],
			receivedAt: original.receivedAt,
		});
		expect(copy?.mailboxes).toEqual([
			{ mailboxId: archive.id, uid: 1, modseq: copy?.modseq as number },
		]);
		await store.setFlags([copy?.id as string], { add: ['\\Flagged'] });
		expect((await store.getMessage(original.id))?.flags).toEqual(['\\Seen']);
		await store.destroyMessages([original.id]);
		expect(await textOf(store, account.id, original.blobId)).toBe('x');
	});

	test('a link puts the same message in one more mailbox', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		const {
			messages: [linked],
		} = await store.linkMessages([message.id], a.id);
		expect(linked?.id).toBe(message.id);
		expect(linked?.mailboxes.map((m) => [m.mailboxId, m.uid])).toEqual([
			[inbox.id, 1],
			[a.id, 1],
		]);
		const {
			messages: [again],
		} = await store.linkMessages([message.id], a.id);
		expect(again?.modseq).toBe(linked?.modseq);
	});
}

function moving(create: CreateStore): void {
	test('RFC 6851: a move keeps the id, leaves a new UID in the target and an expunge in the source', async () => {
		const { store, account, inbox } = await setup(create);
		const trash = await store.createMailbox(account.id, {
			name: 'Trash',
			role: 'trash',
		});
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		const {
			messages: [moved],
		} = await store.moveMessages([message.id], inbox.id, trash.id);
		expect(moved?.id).toBe(message.id);
		expect(moved?.mailboxes.map((m) => [m.mailboxId, m.uid])).toEqual([
			[trash.id, 1],
		]);
		expect(await store.getMailbox(inbox.id)).toMatchObject({
			messages: 0,
			highestModseq: moved?.modseq,
		});
		expect(await store.getMailbox(trash.id)).toMatchObject({
			messages: 1,
			highestModseq: moved?.modseq,
		});
		const changes = await store.messageChanges(account.id, message.modseq);
		expect(changes.updated).toEqual([message.id]);
		expect(changes.expunged).toEqual([
			{
				messageId: message.id,
				mailboxId: inbox.id,
				uid: 1,
				modseq: moved?.modseq as number,
			},
		]);
		const again = await store.moveMessages([message.id], inbox.id, trash.id);
		expect(again).toEqual({ messages: [], notFound: [message.id] });
	});

	test('a message already in the target keeps its UID there, below uidNext', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		await store.addMessage(a.id, { content: bytes('first') });
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		await store.linkMessages([message.id], a.id);
		await store.addMessage(a.id, { content: bytes('later') });
		const {
			messages: [moved],
		} = await store.moveMessages([message.id], inbox.id, a.id);
		expect(moved?.mailboxes.map((m) => [m.mailboxId, m.uid])).toEqual([
			[a.id, 2],
		]);
		expect((await store.getMailbox(a.id))?.uidNext).toBe(4);
	});
}

function removing(create: CreateStore): void {
	test('a removal takes a message out of one mailbox; out of all, it is destroyed', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		await store.linkMessages([message.id], a.id);
		const {
			expunged: [first],
		} = await store.removeMessages([message.id, message.id], inbox.id);
		expect(first).toMatchObject({
			messageId: message.id,
			mailboxId: inbox.id,
			uid: 1,
		});
		expect(await store.getMessage(message.id)).toBeDefined();
		expect(await store.removeMessages([message.id], inbox.id)).toEqual({
			expunged: [],
			notFound: [message.id],
		});
		await store.removeMessages([message.id], a.id);
		expect(await store.getMessage(message.id)).toBeUndefined();
		expect(await store.readContent(account.id, message.blobId)).toBeUndefined();
	});

	test('destroying a message expunges it from every mailbox', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		await store.linkMessages([message.id], a.id);
		const { expunged } = await store.destroyMessages([message.id]);
		expect(expunged.map((e) => e.mailboxId).sort()).toEqual(
			[inbox.id, a.id].sort(),
		);
		expect((await store.destroyMessages([message.id])).notFound).toEqual([
			message.id,
		]);
	});
}

function accounts(create: CreateStore): void {
	test("messages never cross accounts: another account's id is not found", async () => {
		const { store, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		const theirs = await store.createMailbox(other.id, {
			name: 'INBOX',
			role: 'inbox',
		});
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		const none = { messages: [], notFound: [message.id] };
		expect(await store.copyMessages([message.id], theirs.id)).toEqual(none);
		expect(await store.linkMessages([message.id], theirs.id)).toEqual(none);
		expect(await store.removeMessages([message.id], theirs.id)).toEqual({
			expunged: [],
			notFound: [message.id],
		});
		await rejects(
			store.moveMessages([message.id], inbox.id, theirs.id),
			'INVALID',
		);
		expect((await store.getMessage(message.id))?.mailboxes).toHaveLength(1);
	});
}
