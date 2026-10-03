import { describe, expect, test } from 'bun:test';
import {
	bytes,
	type CreateStore,
	rejects,
	setup,
	textOf,
} from './setup.fixtures';

export function describeMessages(create: CreateStore): void {
	describe('messages', () => {
		adding(create);
		listing(create);
		threads(create);
	});
}

function adding(create: CreateStore): void {
	test('get ascending UIDs and modseqs, and their content back', async () => {
		const { store, account, inbox } = await setup(create);
		const when = new Date('2026-01-02T03:04:05Z');
		const first = await store.addMessage(account.id, inbox.id, {
			content: bytes('Subject: a\r\n\r\nA\r\n'),
			receivedAt: when,
		});
		const second = await store.addMessage(account.id, inbox.id, {
			content: bytes('Subject: b\r\n\r\nB\r\n'),
			flags: ['\\seen'],
		});
		expect(first).toMatchObject({ size: 17, flags: [], receivedAt: when });
		expect(first.mailboxes).toEqual([
			{ mailboxId: inbox.id, uid: 1, modseq: first.modseq },
		]);
		expect(first.createdModseq).toBe(first.modseq);
		expect(second.mailboxes[0]?.uid).toBe(2);
		expect(second.modseq).toBeGreaterThan(first.modseq);
		expect(second.flags).toEqual(['\\Seen']);
		expect(await textOf(store, account.id, first.blobId)).toBe(
			'Subject: a\r\n\r\nA\r\n',
		);
		expect(await store.getMessage(account.id, first.id)).toEqual(first);
		expect(await store.getMailbox(account.id, inbox.id)).toMatchObject({
			uidNext: 3,
			messages: 2,
			unseen: 1,
			highestModseq: second.modseq,
		});
	});

	test('RFC 9051 §2.3.1.1: a UID is never reused, even after a removal', async () => {
		const { store, account, inbox } = await setup(create);
		const first = await store.addMessage(account.id, inbox.id, {
			content: bytes('1'),
		});
		await store.removeMessages(account.id, [first.id], inbox.id);
		const second = await store.addMessage(account.id, inbox.id, {
			content: bytes('2'),
		});
		expect(second.mailboxes[0]?.uid).toBe(2);
	});

	test('an invalid date, an unknown mailbox or a bad option is refused', async () => {
		const { store, account, inbox } = await setup(create);
		for (const receivedAt of [new Date(Number.NaN), '2020' as never]) {
			await rejects(
				store.addMessage(account.id, inbox.id, {
					content: bytes('x'),
					receivedAt,
				}),
				'INVALID',
			);
		}
		await rejects(
			store.addMessage(account.id, 'nope', { content: bytes('x') }),
			'NOT_FOUND',
		);
		await rejects(store.listMessages(account.id, 'nope'), 'NOT_FOUND');
		await rejects(
			store.listMessages(account.id, inbox.id, { changedSince: -1 }),
			'INVALID',
		);
		expect(await store.getMessage(account.id, 'nope')).toBeUndefined();
		expect(await store.readContent(account.id, 'nope')).toBeUndefined();
	});
}

function listing(create: CreateStore): void {
	test('a mailbox lists in UID order; RFC 7162 §3.1.4 CHANGEDSINCE', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.addMessage(account.id, inbox.id, {
			content: bytes('a'),
		});
		const b = await store.addMessage(account.id, inbox.id, {
			content: bytes('b'),
		});
		const entries = await store.listMessages(account.id, inbox.id);
		expect(entries.map((entry) => entry.uid)).toEqual([1, 2]);
		expect(entries[1]?.message).toEqual(b);
		expect(
			(await store.listMessages(account.id, inbox.id, { fromUid: 2 })).map(
				(e) => e.uid,
			),
		).toEqual([2]);
		await store.setFlags(account.id, [a.id], { add: ['\\Seen'] });
		const changed = await store.listMessages(account.id, inbox.id, {
			changedSince: b.modseq,
		});
		expect(changed.map((entry) => entry.message.id)).toEqual([a.id]);
	});

	test('an account lists every message, oldest first, a page at a time', async () => {
		const { store, account, inbox } = await setup(create);
		const box = await store.createMailbox(account.id, { name: 'Other' });
		const ids = [
			(await store.addMessage(account.id, inbox.id, { content: bytes('a') }))
				.id,
			(await store.addMessage(account.id, box.id, { content: bytes('b') })).id,
			(await store.addMessage(account.id, inbox.id, { content: bytes('c') }))
				.id,
		];
		const all = await store.listAccountMessages(account.id);
		expect(all.messages.map((m) => m.id)).toEqual(ids);
		expect(all.total).toBe(3);
		const page = await store.listAccountMessages(account.id, {
			offset: 1,
			limit: 1,
		});
		expect(page).toMatchObject({ total: 3 });
		expect(page.messages.map((m) => m.id)).toEqual(ids.slice(1, 2));
		await rejects(
			store.listAccountMessages(account.id, { limit: 0 }),
			'INVALID',
		);
	});
}

function threads(create: CreateStore): void {
	test('RFC 8621 §4.1.1: a thread id, its own by default, kept by a copy', async () => {
		const { store, account, inbox } = await setup(create);
		const box = await store.createMailbox(account.id, { name: 'Other' });
		const first = await store.addMessage(account.id, inbox.id, {
			content: bytes('a'),
		});
		expect(first.threadId).toBe(first.id);
		const reply = await store.addMessage(account.id, inbox.id, {
			content: bytes('b'),
			threadId: first.threadId,
		});
		expect(reply.threadId).toBe(first.id);
		const {
			messages: [copy],
		} = await store.copyMessages(account.id, [reply.id], box.id);
		expect(copy?.threadId).toBe(first.id);
		for (const threadId of ['', 'a b', 7 as never]) {
			await rejects(
				store.addMessage(account.id, inbox.id, {
					content: bytes('x'),
					threadId,
				}),
				'INVALID',
			);
		}
	});
}
