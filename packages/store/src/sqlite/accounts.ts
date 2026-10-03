import { loginKey, normalizeLogin } from '../contract/checks';
import type { Account } from '../contract/types';
import { StoreError } from '../errors';
import type { SqliteState } from './state';

export function getAccount(
	state: SqliteState,
	id: string,
): Account | undefined {
	const row = state.db
		.query<{ id: string; name: string }, [string]>(
			'SELECT id, name FROM accounts WHERE id = ?',
		)
		.get(String(id));
	return row ? state.accountView(row) : undefined;
}

/** The account with this login, compared case-insensitively. */
export function findAccount(
	state: SqliteState,
	name: string,
): Account | undefined {
	const row = state.db
		.query<{ id: string; name: string }, [string]>(
			'SELECT id, name FROM accounts WHERE login_key = ?',
		)
		.get(loginKey(name));
	return row ? state.accountView(row) : undefined;
}

export function createAccount(state: SqliteState, name: string): Account {
	const login = normalizeLogin(name);
	return state.atomic(() => {
		if (findAccount(state, login)) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`An account "${login}" already exists`,
			);
		}
		const account = { id: crypto.randomUUID(), name: login };
		state.db
			.query('INSERT INTO accounts (id, name, login_key) VALUES (?, ?, ?)')
			.run(account.id, login, loginKey(login));
		return account;
	});
}

/** Deletes the account, its mailboxes and what it remembers of its changes. */
export function deleteAccount(state: SqliteState, id: string): void {
	state.atomic(() => {
		state.account(id);
		// Mailboxes and tombstones go with the account (ON DELETE CASCADE).
		state.db.query('DELETE FROM accounts WHERE id = ?').run(id);
	});
}
