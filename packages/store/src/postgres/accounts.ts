import { loginKey, normalizeLogin } from '../contract/checks';
import { accountExists } from '../contract/conflicts';
import type { Account } from '../contract/types';
import { StoreError } from '../errors';
import type { PgState } from './state';
import { isStorable } from './storable';

export function getAccount(
	state: PgState,
	id: string,
): Promise<Account | undefined> {
	return state.direct(async (db) => {
		const row = await db.findAccountRow(id);
		return row && { id: row.id, name: row.name };
	});
}

/** The account with this login, compared case-insensitively. */
export function findAccount(
	state: PgState,
	name: string,
): Promise<Account | undefined> {
	const key = loginKey(name);
	return state.direct(async (db) => {
		// A login PostgreSQL cannot hold is one no account has.
		if (!isStorable(key)) return undefined;
		return db.one<Account>(
			`SELECT id, name FROM ${db.t.accounts} WHERE login_key = $1`,
			[key],
		);
	});
}

/**
 * One statement: of two instances creating one login at once, the
 * unique index lets one insert, and the other finds the row taken.
 */
export function createAccount(state: PgState, name: string): Promise<Account> {
	const login = normalizeLogin(name);
	if (!isStorable(login)) {
		throw new StoreError(
			'INVALID',
			'An account name PostgreSQL keeps holds no NUL and no lone surrogate',
		);
	}
	const account = { id: crypto.randomUUID(), name: login };
	return state.direct(async (db) => {
		const inserted = await db.rows(
			`INSERT INTO ${db.t.accounts} (id, name, login_key) VALUES ($1, $2, $3)
			ON CONFLICT (login_key) DO NOTHING RETURNING id`,
			[account.id, login, loginKey(login)],
		);
		if (inserted.length === 0) throw accountExists(login);
		return account;
	});
}

/** Deletes the account and, with it, its mailboxes, messages, content and tombstones. */
export function deleteAccount(state: PgState, id: string): Promise<void> {
	return state.write(id, async (w) => {
		// The rest goes with the account (ON DELETE CASCADE).
		await w.rows(`DELETE FROM ${w.t.accounts} WHERE id = $1`, [id]);
	});
}
