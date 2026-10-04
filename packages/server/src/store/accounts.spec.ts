import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { MemoryMailStore } from '@bumail/store';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { tempDir } from '../config/config.fixtures';
import { ServerError } from '../errors';
import { MAILBOXES, provisionAccount, purgeAccount } from './accounts';
import { openStore } from './open';

const closing: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of closing.splice(0)) await close();
});

function sqliteStore(directory = join(tempDir(), 'mail')): SqliteMailStore {
	const store = SqliteMailStore.open({ directory });
	closing.push(() => store.close());
	return store;
}

describe('provisionAccount', () => {
	test('creates the account, named by the address, with its six mailboxes', async () => {
		const store = sqliteStore();
		const account = await provisionAccount(store, 'alice@example.com');
		expect(account.name).toBe('alice@example.com');
		const mailboxes = await store.listMailboxes(account.id);
		expect(mailboxes.map(({ name, role }) => [name, role]).sort()).toEqual(
			MAILBOXES.map(([name, role]) => [name, role]).sort(),
		);
	});

	test('is safe to run again and at once, keeping what is there', async () => {
		const store = sqliteStore();
		const [first, second] = await Promise.all([
			provisionAccount(store, 'alice@example.com'),
			provisionAccount(store, 'alice@example.com'),
		]);
		expect(second.id).toBe(first.id);
		const trash = await store.findMailbox(first.id, 'trash');
		await store.renameMailbox(first.id, trash?.id ?? '', { name: 'Bin' });
		const junk = await store.findMailbox(first.id, 'junk');
		await store.deleteMailbox(first.id, junk?.id ?? '');
		expect((await provisionAccount(store, 'alice@example.com')).id).toBe(
			first.id,
		);
		const names = (await store.listMailboxes(first.id)).map(({ name }) => name);
		expect(names).toContain('Bin');
		expect(names).toContain('Junk');
		expect(names).not.toContain('Trash');
	});

	test('finds an account kept from a user removed earlier, with its mail', async () => {
		const store = new MemoryMailStore();
		const account = await provisionAccount(store, 'alice@example.com');
		const inbox = await store.findMailbox(account.id, 'inbox');
		await store.addMessage(account.id, inbox?.id ?? '', {
			content: new TextEncoder().encode('Subject: kept\r\n\r\nhi\r\n'),
		});
		const again = await provisionAccount(store, 'Alice@example.com');
		expect(again.id).toBe(account.id);
		expect((await store.listAccountMessages(account.id)).messages.length).toBe(
			1,
		);
	});
});

describe('purgeAccount', () => {
	test('deletes the account and its mail; false when there is none', async () => {
		const store = sqliteStore();
		const account = await provisionAccount(store, 'alice@example.com');
		expect(await purgeAccount(store, 'alice@example.com')).toBe(true);
		expect(await store.getAccount(account.id)).toBeUndefined();
		expect(await purgeAccount(store, 'alice@example.com')).toBe(false);
	});
});

describe('openStore', () => {
	test('opens a sqlite: store, and says when another process holds it', async () => {
		const dir = join(tempDir(), 'mail');
		const { store, close } = openStore({
			url: `sqlite:${dir}`,
			plaintext: false,
		});
		closing.push(close);
		await provisionAccount(store, 'alice@example.com');
		let error: unknown;
		try {
			openStore({ url: `sqlite:${dir}`, plaintext: false });
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(ServerError);
		expect((error as ServerError).message).toBe(
			'the mail store is in use by another process, such as the running server',
		);
	});
});
