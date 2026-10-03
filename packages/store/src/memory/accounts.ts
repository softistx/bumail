import { loginKey, normalizeLogin } from '../contract/checks';
import { accountExists } from '../contract/conflicts';
import type { Account } from '../contract/types';
import type { MemoryState } from './state';

/** The account with this login, compared case-insensitively; a copy. */
export function findAccount(
	state: MemoryState,
	name: string,
): Account | undefined {
	const key = loginKey(name);
	for (const { account } of state.accounts.values()) {
		if (account.name.toLowerCase() === key) return { ...account };
	}
	return undefined;
}

export function createAccount(state: MemoryState, name: string): Account {
	const login = normalizeLogin(name);
	if (findAccount(state, login)) {
		throw accountExists(login);
	}
	const account = { id: crypto.randomUUID(), name: login };
	state.accounts.set(account.id, {
		account,
		modseq: 0,
		floor: 0,
		tombstones: [],
	});
	return { ...account };
}

/** Deletes the account, its mailboxes, its messages and their blobs. */
export function deleteAccount(state: MemoryState, id: string): void {
	state.account(id);
	for (const message of [...state.messages.values()]) {
		if (message.accountId !== id) continue;
		state.messages.delete(message.id);
		state.release(id, message.blobId);
	}
	for (const mailbox of [...state.mailboxes.values()]) {
		if (mailbox.accountId === id) state.mailboxes.delete(mailbox.id);
	}
	state.accounts.delete(id);
}
