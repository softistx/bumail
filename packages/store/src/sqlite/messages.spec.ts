import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bytes, streamOf } from '../contract/fixtures/setup.fixtures';
import { temporaryStores } from './directories.fixtures';

const { directory, open } = temporaryStores();

const blobFile = (at: string, blobId: string) =>
	join(at, 'blobs', blobId.slice(0, 2), blobId);

describe('SqliteMailStore: messages on disk', () => {
	test('messages, flags, UIDs and changes survive a reopen', async () => {
		const at = directory();
		const first = open(at);
		const account = await first.createAccount('mary@example.net');
		const inbox = await first.createMailbox(account.id, { name: 'INBOX' });
		const archive = await first.createMailbox(account.id, { name: 'Archive' });
		const a = await first.addMessage(account.id, inbox.id, {
			content: bytes('a'),
			flags: ['$Label'],
			receivedAt: new Date('2026-01-02T03:04:05Z'),
		});
		const b = await first.addMessage(account.id, inbox.id, {
			content: streamOf([bytes('b')]),
		});
		await first.setFlags(account.id, [a.id], { add: ['\\Seen'] });
		await first.moveMessages(account.id, [b.id], inbox.id, archive.id);
		const { modseq } = await first.messageChanges(account.id, 0);
		const before = await first.listAccountMessages(account.id);
		const boxes = await first.listMailboxes(account.id);
		first.close();

		const again = open(at);
		expect(await again.listAccountMessages(account.id)).toEqual(before);
		expect(await again.listMailboxes(account.id)).toEqual(boxes);
		expect((await again.getMessage(account.id, a.id))?.flags).toEqual([
			'$label',
			'\\Seen',
		]);
		expect(await (await again.readContent(account.id, b.blobId))?.text()).toBe(
			'b',
		);
		const c = await again.addMessage(account.id, inbox.id, {
			content: bytes('c'),
		});
		expect(c.mailboxes[0]?.uid).toBe(3);
		expect(c.modseq).toBe(modseq + 1);
		expect(
			(await again.messageChanges(account.id, a.modseq)).expunged,
		).toMatchObject([{ messageId: b.id, mailboxId: inbox.id, uid: 2 }]);
	});
});

describe('SqliteMailStore: blobs and accounts', () => {
	test('an account reads only the blobs it holds; the file goes with the last holder', async () => {
		const at = directory();
		const store = open(at);
		const mary = await store.createAccount('mary@example.net');
		const john = await store.createAccount('john@example.net');
		const hers = await store.createMailbox(mary.id, { name: 'INBOX' });
		const his = await store.createMailbox(john.id, { name: 'INBOX' });
		const mine = await store.addMessage(mary.id, hers.id, {
			content: bytes('shared bytes'),
		});
		const file = blobFile(at, mine.blobId);
		expect(await store.readContent(john.id, mine.blobId)).toBeUndefined();
		const theirs = await store.addMessage(john.id, his.id, {
			content: bytes('shared bytes'),
		});
		expect(theirs.blobId).toBe(mine.blobId);
		expect(await (await store.readContent(john.id, mine.blobId))?.text()).toBe(
			'shared bytes',
		);
		await store.destroyMessages(mary.id, [mine.id]);
		expect(await store.readContent(mary.id, mine.blobId)).toBeUndefined();
		expect(existsSync(file)).toBe(true);
		await store.deleteAccount(john.id);
		expect(existsSync(file)).toBe(false);
		for (const blobId of ['../mail.sqlite', 'x'.repeat(64), '']) {
			expect(await store.readContent(mary.id, blobId)).toBeUndefined();
		}
	});

	test('a removal racing an add of the same bytes never loses the blob', async () => {
		const at = directory();
		const store = open(at);
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		for (let round = 0; round < 20; round++) {
			const old = await store.addMessage(account.id, inbox.id, {
				content: bytes('raced'),
			});
			const [, added] = await Promise.all([
				store.destroyMessages(account.id, [old.id]),
				store.addMessage(account.id, inbox.id, {
					content: streamOf([bytes('rac'), bytes('ed')]),
				}),
			]);
			expect(existsSync(blobFile(at, added.blobId))).toBe(true);
			expect(
				await (await store.readContent(account.id, added.blobId))?.text(),
			).toBe('raced');
			await store.destroyMessages(account.id, [added.id]);
			expect(existsSync(blobFile(at, added.blobId))).toBe(false);
		}
	});
});
