import { describe, expect, test } from 'bun:test';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeAccounts(create: CreateStore): void {
	describe('accounts', () => {
		test('are found by id and by login, case-insensitively', async () => {
			const { store, account } = await setup(create);
			expect(await store.getAccount(account.id)).toEqual(account);
			expect(await store.findAccount('MARY@example.NET')).toEqual(account);
			expect(await store.findAccount('nobody@example.net')).toBeUndefined();
			expect(await store.getAccount('nope')).toBeUndefined();
		});

		test('a login is unique, and not empty', async () => {
			const { store } = await setup(create);
			await rejects(store.createAccount('Mary@Example.net'), 'ALREADY_EXISTS');
			await rejects(store.createAccount('  '), 'INVALID');
		});

		test('deleting one deletes its mailboxes, messages and blobs', async () => {
			const { store, account, inbox } = await setup(create);
			const message = await store.addMessage(inbox.id, { content: bytes('x') });
			await store.deleteAccount(account.id);
			expect(await store.getAccount(account.id)).toBeUndefined();
			expect(await store.getMailbox(inbox.id)).toBeUndefined();
			expect(await store.getMessage(message.id)).toBeUndefined();
			expect(await store.readContent(message.blobId)).toBeUndefined();
			await rejects(store.deleteAccount(account.id), 'NOT_FOUND');
		});

		test('a method given an unknown account is NOT_FOUND', async () => {
			const { store } = await setup(create);
			await rejects(store.listMailboxes('nope'), 'NOT_FOUND');
			await rejects(store.findMailbox('nope', 'inbox'), 'NOT_FOUND');
			await rejects(store.createMailbox('nope', { name: 'A' }), 'NOT_FOUND');
			await rejects(store.messageChanges('nope', 0), 'NOT_FOUND');
			await rejects(store.mailboxChanges('nope', 0), 'NOT_FOUND');
		});
	});
}
