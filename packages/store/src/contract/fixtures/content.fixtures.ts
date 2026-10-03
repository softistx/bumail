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

export function describeContent(create: CreateStore): void {
	describe('content', () => {
		content(create);
		blobs(create);
	});
}

function content(create: CreateStore): void {
	test('content may come as a stream, hashed and counted as it reads', async () => {
		const { store, account, inbox } = await setup(create);
		const parts = ['Subject: s\r\n', '\r\n', 'streamed\r\n'];
		const message = await store.addMessage(account.id, inbox.id, {
			content: streamOf(parts.map(bytes)),
		});
		const whole = parts.join('');
		expect(message.size).toBe(whole.length);
		expect(message.blobId).toBe(blobIdOf(bytes(whole)));
		const blob = await store.readContent(account.id, message.blobId);
		expect(await blob?.slice(0, 10).text()).toBe('Subject: s');
		await rejects(
			store.addMessage(account.id, inbox.id, { content: 'text' as never }),
			'INVALID',
		);
	});

	test('a stream that fails, yields what is not bytes or is locked adds nothing', async () => {
		const { store, account, inbox } = await setup(create);
		const before = await store.messageChanges(account.id, 0);
		const locked = streamOf([bytes('x')]);
		const reader = locked.getReader();
		await rejects(
			store.addMessage(account.id, inbox.id, { content: locked }),
			'INVALID',
		);
		reader.releaseLock();
		await rejects(
			store.addMessage(account.id, inbox.id, {
				content: streamOf([bytes('half')], new Error('connection reset')),
			}),
			'INVALID',
		);
		await rejects(
			store.addMessage(account.id, inbox.id, {
				content: streamOf([bytes('a'), 'not bytes']),
			}),
			'INVALID',
		);
		expect((await store.messageChanges(account.id, 0)).modseq).toBe(
			before.modseq,
		);
		expect((await store.getMailbox(account.id, inbox.id))?.messages).toBe(0);
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
		const adding = store.addMessage(account.id, box.id, { content: stream });
		push(bytes('slow'));
		await store.deleteMailbox(account.id, box.id);
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
		const a = await store.addMessage(account.id, inbox.id, {
			content: bytes('same'),
		});
		const b = await store.addMessage(account.id, inbox.id, {
			content: bytes('same'),
		});
		expect(a.blobId).toBe(
			'0967115f2813a3541eaef77de9d9d5773f1c0c04314b0bbfe4ff3b3b1c55b5d5',
		);
		expect(b.blobId).toBe(a.blobId);
		await store.destroyMessages(account.id, [a.id]);
		expect(await textOf(store, account.id, a.blobId)).toBe('same');
		await store.destroyMessages(account.id, [b.id]);
		expect(await store.readContent(account.id, a.blobId)).toBeUndefined();
	});

	test('a blob is read only through its own account, even with equal bytes', async () => {
		const { store, account, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		const theirs = await store.createMailbox(other.id, { name: 'INBOX' });
		const mine = await store.addMessage(account.id, inbox.id, {
			content: bytes('secret'),
		});
		expect(await store.readContent(other.id, mine.blobId)).toBeUndefined();
		const same = await store.addMessage(other.id, theirs.id, {
			content: bytes('secret'),
		});
		await store.destroyMessages(other.id, [same.id]);
		expect(await textOf(store, account.id, mine.blobId)).toBe('secret');
	});
}
