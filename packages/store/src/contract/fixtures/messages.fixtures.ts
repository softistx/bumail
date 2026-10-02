import { describe, expect, test } from 'bun:test';
import { blobIdOf } from '../blob';
import {
	bytes,
	type CreateStore,
	rejects,
	setup,
	textOf,
} from './setup.fixtures';

export function describeMessages(create: CreateStore): void {
	describe('messages', () => {
		test('get ascending UIDs and modseqs, and their content back', async () => {
			const { store, inbox } = await setup(create);
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
			expect(await textOf(store, first.blobId)).toBe('Subject: a\r\n\r\nA\r\n');
			expect(await store.getMessage(first.id)).toEqual(first);
			expect(await store.getMailbox(inbox.id)).toMatchObject({
				uidNext: 3,
				messages: 2,
				unseen: 1,
				highestModseq: second.modseq,
			});
			const entries = await store.listMessages(inbox.id);
			expect(entries.map((entry) => entry.uid)).toEqual([1, 2]);
			expect(entries[1]?.message).toEqual(second);
			expect(
				(await store.listMessages(inbox.id, { fromUid: 2 })).map((e) => e.uid),
			).toEqual([2]);
		});

		test('content may come as a stream, hashed and counted as it reads', async () => {
			const { store, inbox } = await setup(create);
			const parts = ['Subject: s\r\n', '\r\n', 'streamed\r\n'];
			const content = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const part of parts) controller.enqueue(bytes(part));
					controller.close();
				},
			});
			const message = await store.addMessage(inbox.id, { content });
			const whole = parts.join('');
			expect(message.size).toBe(whole.length);
			expect(message.blobId).toBe(blobIdOf(bytes(whole)));
			const blob = await store.readContent(message.blobId);
			expect(await blob?.slice(0, 10).text()).toBe('Subject: s');
			await rejects(
				store.addMessage(inbox.id, { content: 'text' as never }),
				'INVALID',
			);
		});

		test('RFC 9051 §2.3.1.1: a UID is never reused, even after a removal', async () => {
			const { store, inbox } = await setup(create);
			const first = await store.addMessage(inbox.id, { content: bytes('1') });
			await store.removeMessages([first.id], inbox.id);
			const second = await store.addMessage(inbox.id, { content: bytes('2') });
			expect(second.mailboxes[0]?.uid).toBe(2);
		});

		test('the blob id is the SHA-256 of the content, shared by equal contents', async () => {
			const { store, inbox } = await setup(create);
			const a = await store.addMessage(inbox.id, { content: bytes('same') });
			const b = await store.addMessage(inbox.id, { content: bytes('same') });
			expect(a.blobId).toBe(
				'0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
			);
			expect(b.blobId).toBe(a.blobId);
			await store.destroyMessages([a.id]);
			expect(await textOf(store, a.blobId)).toBe('same');
			await store.destroyMessages([b.id]);
			expect(await store.readContent(a.blobId)).toBeUndefined();
		});

		test('an invalid date, an unknown mailbox or a bad option is refused', async () => {
			const { store, inbox } = await setup(create);
			await rejects(
				store.addMessage(inbox.id, {
					content: bytes('x'),
					receivedAt: new Date(Number.NaN),
				}),
				'INVALID',
			);
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
			expect(await store.readContent('nope')).toBeUndefined();
		});

		test('RFC 7162 §3.1.4: CHANGEDSINCE lists the messages changed after a modseq', async () => {
			const { store, inbox } = await setup(create);
			const a = await store.addMessage(inbox.id, { content: bytes('a') });
			const b = await store.addMessage(inbox.id, { content: bytes('b') });
			await store.setFlags([a.id], { add: ['\\Seen'] });
			const changed = await store.listMessages(inbox.id, {
				changedSince: b.modseq,
			});
			expect(changed.map((entry) => entry.message.id)).toEqual([a.id]);
		});
	});
}
