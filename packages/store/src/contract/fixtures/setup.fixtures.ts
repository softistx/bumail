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

/** The text of a blob of the account. */
export async function textOf(
	store: MailStore,
	accountId: string,
	blobId: string,
) {
	return (await store.readContent(accountId, blobId))?.text();
}

/** A stream of these parts, then `end`: closing, or failing with an error. */
export function streamOf(parts: readonly unknown[], end?: Error) {
	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const part of parts) controller.enqueue(part as Uint8Array);
			if (end) controller.error(end);
			else controller.close();
		},
	});
}

/** Expects a promise to reject with a StoreError of this code. */
export async function rejects(promise: Promise<unknown>, code: string) {
	await expect(promise).rejects.toMatchObject({ name: 'StoreError', code });
}
