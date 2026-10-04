import { expect, test } from 'bun:test';
import { bytes, rejects } from '../contract/fixtures/setup.fixtures';
import { describePostgres, temporaryStores } from './databases.fixtures';

// What PostgreSQL itself would refuse — a NUL in text, a lone surrogate,
// which `Bun.SQL` would send as U+FFFD — must reach it as nothing at all:
// an id no row has, a value the contract refuses. Never a database error,
// and never a match on other text.

const HOSTILE = [
	'a\0b',
	'\0',
	'\ud800',
	'x\udfffy',
	"'; DROP TABLE accounts; --",
	'$1',
	'%',
	'x'.repeat(100_000),
];

describePostgres('PostgresMailStore: hostile input', (url) => {
	const { create } = temporaryStores(url);

	async function setup() {
		const store = create();
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
		});
		return { store, account, inbox, message };
	}

	test('an id PostgreSQL cannot hold names nothing, wherever it is given', async () => {
		const { store, account, inbox, message } = await setup();
		for (const bad of HOSTILE) {
			expect(await store.getAccount(bad)).toBeUndefined();
			expect(await store.findAccount(bad)).toBeUndefined();
			await rejects(store.listMailboxes(bad), 'NOT_FOUND');
			await rejects(store.deleteAccount(bad), 'NOT_FOUND');
			await rejects(store.readContent(bad, message.blobId), 'NOT_FOUND');
			expect(await store.getMailbox(account.id, bad)).toBeUndefined();
			expect(await store.getMessage(account.id, bad)).toBeUndefined();
			expect(await store.readContent(account.id, bad)).toBeUndefined();
			await rejects(store.listMessages(account.id, bad), 'NOT_FOUND');
			await rejects(
				store.createMailbox(account.id, { name: 'Child', parentId: bad }),
				'NOT_FOUND',
			);
			await rejects(
				store.messageChanges(account.id, 0, { mailboxId: bad }),
				'NOT_FOUND',
			);
			await rejects(
				store.addMessage(account.id, bad, { content: bytes('y') }),
				'NOT_FOUND',
			);
			const flagged = await store.setFlags(account.id, [bad, message.id], {
				add: ['\\Seen'],
			});
			expect(flagged.notFound).toEqual([bad]);
			expect(flagged.messages.map((m) => m.id)).toEqual([message.id]);
			const moved = await store.removeMessages(account.id, [bad], inbox.id);
			expect(moved).toEqual({ expunged: [], notFound: [bad] });
		}
		// Nothing was dropped, nothing was matched.
		expect(await store.getMessage(account.id, message.id)).toBeDefined();
	});

	test('a lone surrogate never matches the text U+FFFD would make of it', async () => {
		const store = create();
		const replaced = await store.createAccount('a�b@example.net');
		expect(await store.findAccount('a\ud800b@example.net')).toBeUndefined();
		expect(await store.findAccount('A�B@example.net')).toEqual(replaced);
		const box = await store.createMailbox(replaced.id, { name: 'x�' });
		expect(await store.getMailbox(replaced.id, box.id)).toMatchObject({
			name: 'x�',
		});
	});

	test('a login or a mailbox name PostgreSQL would not keep as given is INVALID', async () => {
		const { store, account } = await setup();
		for (const login of ['a\0b@example.net', 'a\ud800@example.net']) {
			await expect(store.createAccount(login)).rejects.toMatchObject({
				code: 'INVALID',
				message:
					'An account name PostgreSQL keeps holds no NUL and no lone surrogate',
			});
		}
		await expect(
			store.createMailbox(account.id, { name: 'Box \udc00' }),
		).rejects.toMatchObject({
			code: 'INVALID',
			message:
				'A mailbox name PostgreSQL keeps holds no NUL and no lone surrogate',
		});
		await expect(
			store.createAccount(`${'x'.repeat(1015)}@example.net`),
		).rejects.toMatchObject({
			code: 'INVALID',
			message:
				'An account name PostgreSQL keeps is at most 1024 bytes of UTF-8',
		});
		const longest = `${'é'.repeat(506)}@example.net`; // 1024 bytes
		expect((await store.createAccount(longest)).name).toBe(longest);
		const work = await store.createMailbox(account.id, { name: 'Work' });
		await expect(
			store.renameMailbox(account.id, work.id, { name: '\ud83d' }),
		).rejects.toMatchObject({ code: 'INVALID' });
		// A pair is whole: kept as given.
		const emoji = await store.renameMailbox(account.id, work.id, {
			name: 'Work 📨',
		});
		expect(emoji.name).toBe('Work 📨');
	});

	test('content is bytes: every byte value, kept and read back exactly', async () => {
		const { store, account, inbox } = await setup();
		const all = Uint8Array.from({ length: 4096 }, (_, i) => i % 256);
		const big = new Uint8Array(3 * 1024 * 1024).map((_, i) => (i * 7) % 251);
		for (const content of [all, big, new Uint8Array(0)]) {
			const message = await store.addMessage(account.id, inbox.id, { content });
			const blob = await store.readContent(account.id, message.blobId);
			expect(blob?.size).toBe(content.length);
			expect(new Uint8Array((await blob?.arrayBuffer()) ?? [])).toEqual(
				content,
			);
			// A range of it, as IMAP's partial FETCH reads it.
			expect(
				new Uint8Array((await blob?.slice(10, 20).arrayBuffer()) ?? []),
			).toEqual(content.slice(10, 20));
		}
	});

	test('numbers at the edge of what JavaScript counts reach PostgreSQL as numbers', async () => {
		const { store, account, inbox, message } = await setup();
		const max = Number.MAX_SAFE_INTEGER;
		expect(
			await store.listMessages(account.id, inbox.id, { fromUid: max }),
		).toEqual([]);
		expect(
			await store.listMessages(account.id, inbox.id, { changedSince: max }),
		).toEqual([]);
		const page = await store.listAccountMessages(account.id, {
			offset: max,
			limit: max,
		});
		expect(page).toEqual({ messages: [], total: 1 });
		const flagged = await store.setFlags(
			account.id,
			[message.id],
			{ add: ['\\Seen'] },
			{ unchangedSince: max },
		);
		expect(flagged.modified).toEqual([]);
		await rejects(store.messageChanges(account.id, max), 'INVALID');
		await rejects(
			store.messageChanges(account.id, 0, { limit: max + 1 }),
			'INVALID',
		);
		expect(
			(await store.messageChanges(account.id, 0, { limit: max })).created,
		).toEqual([message.id]);
	});

	test('many ids in one call are one statement, not one each', async () => {
		const { store, account, message } = await setup();
		const ids = Array.from({ length: 20_000 }, (_, i) => `missing-${i}`);
		const result = await store.setFlags(account.id, [...ids, message.id], {
			add: ['$Done'],
		});
		expect(result.notFound).toHaveLength(20_000);
		expect(result.messages.map((m) => m.flags)).toEqual([['$Done']]);
	});
});
