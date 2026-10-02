import { describe, expect, test } from 'bun:test';
import { blobIdOf } from '../blob';
import {
	bytes,
	type CreateStore,
	rejects,
	setup,
	streamOf,
	textOf,
} from './setup.fixtures';

export function describeMessages(create: CreateStore): void {
	describe('messages', () => {
		adding(create);
		content(create);
		blobs(create);
		listing(create);
		threads(create);
	});
}

function adding(create: CreateStore): void {
	test('get ascending UIDs and modseqs, and their content back', async () => {
		const { store, account, inbox } = await setup(create);
		const when = new Date('2026-01-02T03:04:05Z');
		const first = await store.addMessage(inbox.id, {
			content: bytes('Subject: a\r\n\r\nA\r\n'),
			receivedAt: when,
		});
		const second = await store.addMessage(inbox.id, {
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
		expect(await store.getMessage(first.id)).toEqual(first);
		expect(await store.getMailbox(inbox.id)).toMatchObject({
			uidNext: 3,
			messages: 2,
			unseen: 1,
			highestModseq: second.modseq,
		});
	});

	test('RFC 9051 §2.3.1.1: a UID is never reused, even after a removal', async () => {
		const { store, inbox } = await setup(create);
		const first = await store.addMessage(inbox.id, { content: bytes('1') });
		await store.removeMessages([first.id], inbox.id);
		const second = await store.addMessage(inbox.id, { content: bytes('2') });
		expect(second.mailboxes[0]?.uid).toBe(2);
	});

	test('an invalid date, an unknown mailbox or a bad option is refused', async () => {
		const { store, account, inbox } = await setup(create);
		for (const receivedAt of [new Date(Number.NaN), '2020' as never]) {
			await rejects(
				store.addMessage(inbox.id, { content: bytes('x'), receivedAt }),
				'INVALID',
			);
		}
		await rejects(
			store.addMessage('nope', { content: bytes('x') }),
			'NOT_FOUND',
		);
		await rejects(store.listMessages('nope'), 'NOT_FOUND');
		await rejects(
			store.listMessages(inbox.id, { changedSince: -1 }),
			'INVALID',
		);
		expect(await store.getMessage('nope')).toBeUndefined();
		expect(await store.readContent(account.id, 'nope')).toBeUndefined();
	});
}

function content(create: CreateStore): void {
	test('content may come as a stream, hashed and counted as it reads', async () => {
		const { store, account, inbox } = await setup(create);
		const parts = ['Subject: s\r\n', '\r\n', 'streamed\r\n'];
		const message = await store.addMessage(inbox.id, {
			content: streamOf(parts.map(bytes)),
		});
		const whole = parts.join('');
		expect(message.size).toBe(whole.length);
		expect(message.blobId).toBe(blobIdOf(bytes(whole)));
		const blob = await store.readContent(account.id, message.blobId);
		expect(await blob?.slice(0, 10).text()).toBe('Subject: s');
		await rejects(
			store.addMessage(inbox.id, { content: 'text' as never }),
			'INVALID',
		);
	});

	test('a stream that fails, or yields what is not bytes, adds nothing', async () => {
		const { store, account, inbox } = await setup(create);
		const before = await store.messageChanges(account.id, 0);
		await rejects(
			store.addMessage(inbox.id, {
				content: streamOf([bytes('half')], new Error('connection reset')),
			}),
			'INVALID',
		);
		await rejects(
			store.addMessage(inbox.id, {
				content: streamOf([bytes('a'), 'not bytes']),
			}),
			'INVALID',
		);
		expect((await store.messageChanges(account.id, 0)).modseq).toBe(
			before.modseq,
		);
		expect((await store.getMailbox(inbox.id))?.messages).toBe(0);
	});

	test('a mailbox deleted while its content is read: NOT_FOUND, nothing kept', async () => {
		const { store, account } = await setup(create);
		const box = await store.createMailbox(account.id, { name: 'Brief' });
		let push: (chunk: Uint8Array | null) => void = () => {};
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				push = (chunk) =>
					chunk ? controller.enqueue(chunk) : controller.close();
			},
		});
		const adding = store.addMessage(box.id, { content: stream });
		push(bytes('slow'));
		await store.deleteMailbox(box.id);
		push(null);
		await rejects(adding, 'NOT_FOUND');
		expect(
			await store.readContent(account.id, blobIdOf(bytes('slow'))),
		).toBeUndefined();
	});
}

function blobs(create: CreateStore): void {
	test('the blob id is the SHA-256 of the content, shared by equal contents', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.addMessage(inbox.id, { content: bytes('same') });
		const b = await store.addMessage(inbox.id, { content: bytes('same') });
		expect(a.blobId).toBe(
			'0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
		);
		expect(b.blobId).toBe(a.blobId);
		await store.destroyMessages([a.id]);
		expect(await textOf(store, account.id, a.blobId)).toBe('same');
		await store.destroyMessages([b.id]);
		expect(await store.readContent(account.id, a.blobId)).toBeUndefined();
	});

	test('a blob is read only through its own account, even with equal bytes', async () => {
		const { store, account, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		const theirs = await store.createMailbox(other.id, { name: 'INBOX' });
		const mine = await store.addMessage(inbox.id, { content: bytes('secret') });
		expect(await store.readContent(other.id, mine.blobId)).toBeUndefined();
		const same = await store.addMessage(theirs.id, {
			content: bytes('secret'),
		});
		await store.destroyMessages([same.id]);
		expect(await textOf(store, account.id, mine.blobId)).toBe('secret');
	});
}

function listing(create: CreateStore): void {
	test('a mailbox lists in UID order; RFC 7162 §3.1.4 CHANGEDSINCE', async () => {
		const { store, inbox } = await setup(create);
		const a = await store.addMessage(inbox.id, { content: bytes('a') });
		const b = await store.addMessage(inbox.id, { content: bytes('b') });
		const entries = await store.listMessages(inbox.id);
		expect(entries.map((entry) => entry.uid)).toEqual([1, 2]);
		expect(entries[1]?.message).toEqual(b);
		expect(
			(await store.listMessages(inbox.id, { fromUid: 2 })).map((e) => e.uid),
		).toEqual([2]);
		await store.setFlags([a.id], { add: ['\\Seen'] });
		const changed = await store.listMessages(inbox.id, {
			changedSince: b.modseq,
		});
		expect(changed.map((entry) => entry.message.id)).toEqual([a.id]);
	});

	test('an account lists every message, oldest first, a page at a time', async () => {
		const { store, account, inbox } = await setup(create);
		const box = await store.createMailbox(account.id, { name: 'Other' });
		const ids = [
			(await store.addMessage(inbox.id, { content: bytes('a') })).id,
			(await store.addMessage(box.id, { content: bytes('b') })).id,
			(await store.addMessage(inbox.id, { content: bytes('c') })).id,
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
		const first = await store.addMessage(inbox.id, { content: bytes('a') });
		expect(first.threadId).toBe(first.id);
		const reply = await store.addMessage(inbox.id, {
			content: bytes('b'),
			threadId: first.threadId,
		});
		expect(reply.threadId).toBe(first.id);
		const {
			messages: [copy],
		} = await store.copyMessages([reply.id], box.id);
		expect(copy?.threadId).toBe(first.id);
		for (const threadId of ['', 'a b', 7 as never]) {
			await rejects(
				store.addMessage(inbox.id, { content: bytes('x'), threadId }),
				'INVALID',
			);
		}
	});
}
