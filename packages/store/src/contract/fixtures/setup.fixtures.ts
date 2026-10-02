import { expect } from 'bun:test';
import type { MailStore } from '../mail-store';

export type CreateStore = () => Promise<MailStore> | MailStore;

export const bytes = (text: string) => new TextEncoder().encode(text);

/** A store with one account and its inbox. */
export async function setup(create: CreateStore) {
	const store = await create();
	const account = await store.createAccount('mary@example.net');
	const inbox = await store.createMailbox(account.id, {
		name: 'INBOX',
		role: 'inbox',
	});
	return { store, account, inbox };
}

/** The text of a blob. */
export async function textOf(store: MailStore, blobId: string) {
	return (await store.readContent(blobId))?.text();
}

/** Expects a promise to reject with a StoreError of this code. */
export async function rejects(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ name: 'StoreError', code });
}
