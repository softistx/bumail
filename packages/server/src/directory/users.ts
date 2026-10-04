import type { Database } from 'bun:sqlite';
import { ServerError } from '../errors';
import { addressOf, checkAddress, checkDomain } from './address';
import { immediate } from './database';
import { requireDomain } from './domains';
import { checkPassword, hashPassword } from './password';
import {
	COLUMNS,
	entry,
	randomVersion,
	type UserEntry,
	type UserRow,
} from './records';

export type { UserEntry } from './records';

/** Whether `address` is an alias, read inside the caller's transaction. */
export function isAlias(db: Database, address: string): boolean {
	return (
		db
			.query<unknown, [string]>('SELECT 1 FROM aliases WHERE address = ?')
			.get(address) !== null
	);
}

/** The users: who logs in, and whose mailbox mail is delivered to. */
export class Users {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	#row(address: string): UserRow | undefined {
		return (
			this.#db
				.query<UserRow, [string]>(
					`SELECT ${COLUMNS} FROM users WHERE address = ?`,
				)
				.get(address) ?? undefined
		);
	}

	#require(address: string): UserRow {
		const row = this.#row(address);
		if (row === undefined) {
			throw new ServerError('NOT_FOUND', `the user ${address} does not exist`);
		}
		return row;
	}

	/** The user, or `undefined`, for any spelling of its address. */
	get(address: string): UserEntry | undefined {
		const parsed = addressOf(address);
		const row = parsed === undefined ? undefined : this.#row(parsed.address);
		return row === undefined ? undefined : entry(row);
	}

	/** The user, or `INVALID` for what is not an address, `NOT_FOUND`. */
	require(address: string): UserEntry {
		return entry(this.#require(checkAddress(address).address));
	}

	/**
	 * Refuses what `add` would refuse of the address — `INVALID`,
	 * `NOT_FOUND` for its domain, `ALREADY_EXISTS` — and answers it as
	 * kept, adding nothing: for a caller that asks for the password next.
	 */
	checkAddable(address: string): string {
		const { address: key, domain } = checkAddress(address);
		this.#free(key, domain);
		return key;
	}

	/** Every user, or a domain's, by address. */
	list(domain?: string): UserEntry[] {
		if (domain === undefined) {
			return this.#db
				.query<UserRow, []>(`SELECT ${COLUMNS} FROM users ORDER BY address`)
				.all()
				.map(entry);
		}
		return this.#db
			.query<UserRow, [string]>(
				`SELECT ${COLUMNS} FROM users WHERE domain = ? ORDER BY address`,
			)
			.all(checkDomain(domain))
			.map(entry);
	}

	/**
	 * Adds a user in a domain the server hosts, with the argon2id hash of
	 * `password`: `INVALID` for an address or a password the directory
	 * does not take, `NOT_FOUND` for a domain it does not host,
	 * `ALREADY_EXISTS` for a user or an alias at that address.
	 */
	async add(address: string, password: string): Promise<UserEntry> {
		const { address: key, domain } = checkAddress(address);
		checkPassword(password);
		this.#free(key, domain);
		const hash = await hashPassword(password);
		return immediate(this.#db, () => {
			this.#free(key, domain);
			this.#db
				.query(
					'INSERT INTO users (address, domain, hash, disabled, created, version) VALUES (?, ?, ?, 0, ?, ?)',
				)
				// A random first version: a user removed and added again is
				// not the one a login was cached for.
				.run(key, domain, hash, Date.now(), randomVersion());
			return entry(this.#require(key));
		});
	}

	/** Refuses an address that is taken, or in a domain not hosted. */
	#free(address: string, domain: string): void {
		requireDomain(this.#db, domain);
		if (this.#row(address) !== undefined) {
			throw new ServerError(
				'ALREADY_EXISTS',
				`the user ${address} already exists`,
			);
		}
		if (isAlias(this.#db, address)) {
			throw new ServerError(
				'ALREADY_EXISTS',
				`${address} is an alias; a user cannot take its address`,
			);
		}
	}

	/** Gives a user a new password: `INVALID`, `NOT_FOUND`. */
	async setPassword(address: string, password: string): Promise<void> {
		const { address: key } = checkAddress(address);
		checkPassword(password);
		this.#require(key);
		const hash = await hashPassword(password);
		immediate(this.#db, () => {
			this.#require(key);
			this.#db
				.query(
					'UPDATE users SET hash = ?, version = version + 1 WHERE address = ?',
				)
				.run(hash, key);
		});
	}

	/** Disables a user, or enables it again: `NOT_FOUND`. Answers the user. */
	setDisabled(address: string, disabled: boolean): UserEntry {
		const { address: key } = checkAddress(address);
		return immediate(this.#db, () => {
			this.#require(key);
			this.#db
				.query(
					'UPDATE users SET disabled = ?, version = version + 1 WHERE address = ?',
				)
				.run(disabled ? 1 : 0, key);
			return entry(this.#require(key));
		});
	}

	/**
	 * Refuses what `remove` would refuse — `NOT_FOUND`, or `IN_USE` while
	 * an alias points to the user — and answers the user, without
	 * removing it: for a caller with work to do before (`--purge`).
	 */
	checkRemovable(address: string): UserEntry {
		const { address: key } = checkAddress(address);
		const row = this.#require(key);
		const aliases = this.#db
			.query<{ alias: string }, [string]>(
				'SELECT alias FROM alias_targets WHERE target = ? ORDER BY alias',
			)
			.all(key)
			.map(({ alias }) => alias);
		if (aliases.length > 0) {
			throw new ServerError(
				'IN_USE',
				`${key} is a target of ${aliases.join(', ')}; remove ${aliases.length === 1 ? 'that alias' : 'those aliases'} first`,
			);
		}
		return entry(row);
	}

	/**
	 * Removes a user from the directory: it can no longer log in, and mail
	 * for it is refused. Its mailbox account in the store is not touched
	 * here (see `purgeAccount`). `NOT_FOUND`, or `IN_USE` while an alias
	 * points to it.
	 */
	remove(address: string): UserEntry {
		return immediate(this.#db, () => {
			const user = this.checkRemovable(address);
			this.#db.query('DELETE FROM users WHERE address = ?').run(user.address);
			return user;
		});
	}
}
