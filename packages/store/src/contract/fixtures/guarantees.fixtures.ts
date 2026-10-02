import { describe, expect, test } from 'bun:test';
import {
	bytes,
	type CreateStore,
	rejects,
	setup,
	textOf,
} from './setup.fixtures';

export function describeGuarantees(create: CreateStore): void {
	describe('all or nothing', () => {
		races(create);
		partial(create);
	});
	describe('copies', () => {
		copies(create);
	});
}

function races(create: CreateStore): void {
	test('concurrent creates of one login or one mailbox: exactly one wins', async () => {
		const { store, account } = await setup(create);
		const logins = await Promise.allSettled([
			store.createAccount('a@x'),
			store.createAccount('A@x'),
		]);
		expect(logins.map((r) => r.status).sort()).toEqual([
			'fulfilled',
			'rejected',
		]);
		const boxes = await Promise.allSettled([
			store.createMailbox(account.id, { name: 'Same', role: 'junk' }),
			store.createMailbox(account.id, { name: 'Same', role: 'junk' }),
		]);
		expect(boxes.map((r) => r.status).sort()).toEqual([
			'fulfilled',
			'rejected',
		]);
		expect(
			(await store.listMailboxes(account.id)).filter((m) => m.name === 'Same'),
		).toHaveLength(1);
	});

	test('a move racing a removal never leaves half a move', async () => {
		const { store, account, inbox } = await setup(create);
		const trash = await store.createMailbox(account.id, {
			name: 'Trash',
			role: 'trash',
		});
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		await Promise.allSettled([
			store.moveMessages([message.id], inbox.id, trash.id),
			store.removeMessages([message.id], inbox.id),
		]);
		const left = await store.getMessage(message.id);
		const trashed = await store.getMailbox(trash.id);
		if (left === undefined) {
			expect(trashed?.messages).toBe(0);
		} else {
			expect(left.mailboxes.map((m) => m.mailboxId)).toEqual([trash.id]);
			expect(trashed?.messages).toBe(1);
		}
	});
}

function partial(create: CreateStore): void {
	test('an unknown id is skipped and named; the others are still acted on', async () => {
		const { store, account, inbox } = await setup(create);
		const archive = await store.createMailbox(account.id, { name: 'Archive' });
		const a = await store.addMessage(inbox.id, { content: bytes('a') });
		const b = await store.addMessage(inbox.id, { content: bytes('b') });
		const c = await store.addMessage(inbox.id, { content: bytes('c') });
		const flagged = await store.setFlags([a.id, 'gone'], { add: ['\\Seen'] });
		expect(flagged.notFound).toEqual(['gone']);
		expect(flagged.messages.map((m) => m.flags)).toEqual([['\\Seen']]);
		const copied = await store.copyMessages(['gone', a.id], archive.id);
		expect([copied.messages.length, copied.notFound]).toEqual([1, ['gone']]);
		const moved = await store.moveMessages(
			[b.id, 'gone'],
			inbox.id,
			archive.id,
		);
		expect([moved.messages.length, moved.notFound]).toEqual([1, ['gone']]);
		const removed = await store.removeMessages([c.id, 'gone'], inbox.id);
		expect([removed.expunged.length, removed.notFound]).toEqual([1, ['gone']]);
		const destroyed = await store.destroyMessages(['gone']);
		expect(destroyed).toEqual({ expunged: [], notFound: ['gone'] });
	});

	test('an INVALID call changes nothing, modseq included', async () => {
		const { store, account, inbox } = await setup(create);
		const message = await store.addMessage(inbox.id, { content: bytes('x') });
		const before = await store.messageChanges(account.id, 0);
		await rejects(
			store.setFlags([message.id], { add: ['\\Seen', 'bad flag'] }),
			'INVALID',
		);
		await rejects(
			store.setFlags('nope' as never, { add: ['\\Seen'] }),
			'INVALID',
		);
		expect((await store.messageChanges(account.id, 0)).modseq).toBe(
			before.modseq,
		);
		expect(await store.getMessage(message.id)).toEqual(message);
	});
}

function copies(create: CreateStore): void {
	test('changing what went in or came out never changes the store', async () => {
		const { store, account, inbox } = await setup(create);
		const when = new Date('2026-01-02T03:04:05Z');
		const content = bytes('abc');
		const message = await store.addMessage(inbox.id, {
			content,
			receivedAt: when,
			flags: ['\\Flagged'],
		});
		when.setTime(0);
		content[0] = 0x7a;
		message.receivedAt.setTime(5000);
		(message.flags as string[]).push('\\Seen');
		(message.mailboxes as unknown[]).length = 0;
		const read = await store.getMessage(message.id);
		if (read) {
			read.receivedAt.setTime(6000);
			(read.flags as string[]).push('\\Seen');
		}
		const [entry] = await store.listMessages(inbox.id);
		if (entry) (entry.message.flags as string[]).push('\\Seen');
		const stored = await store.getMessage(message.id);
		expect(stored?.receivedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
		expect(stored?.flags).toEqual(['\\Flagged']);
		expect(stored?.mailboxes).toHaveLength(1);
		expect(await textOf(store, account.id, message.blobId)).toBe('abc');
		expect((await store.getMailbox(inbox.id))?.unseen).toBe(1);
		const found = await store.findAccount('mary@example.net');
		(found as { name: string }).name = 'eve';
		expect((await store.getAccount(account.id))?.name).toBe('mary@example.net');
	});
}
