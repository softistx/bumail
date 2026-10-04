import type { Database } from 'bun:sqlite';
import { ServerError } from '../errors';
import { addressOf, checkAddress, checkDomain } from './address';
import { requireDomain } from './domains';

/**
 * An address whose mail goes to one or more local users. Never further:
 * an alias to an address elsewhere would make the server a relay.
 */
export interface AliasEntry {
	/** `local@domain`, lowercase. */
	readonly address: string;
	readonly domain: string;
	/** The users it delivers to, by address. */
	readonly targets: readonly string[];
	readonly created: Date;
}

interface AliasRow {
	address: string;
	domain: string;
	created: number;
}

/** The aliases: addresses with no mailbox of their own. */
export class Aliases {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	#entry(row: AliasRow): AliasEntry {
		return {
			address: row.address,
			domain: row.domain,
			targets: this.targets(row.address),
			created: new Date(row.created),
		};
	}

	#row(address: string): AliasRow | undefined {
		return (
			this.#db
				.query<AliasRow, [string]>(
					'SELECT address, domain, created FROM aliases WHERE address = ?',
				)
				.get(address) ?? undefined
		);
	}

	/** The targets of the alias at `address`, as kept (lowercase), by address; `[]` for none. */
	targets(address: string): string[] {
		return this.#db
			.query<{ target: string }, [string]>(
				'SELECT target FROM alias_targets WHERE alias = ? ORDER BY target',
			)
			.all(address)
			.map(({ target }) => target);
	}

	/** The alias, or `undefined`, for any spelling of its address. */
	get(address: string): AliasEntry | undefined {
		const parsed = addressOf(address);
		const row = parsed === undefined ? undefined : this.#row(parsed.address);
		return row === undefined ? undefined : this.#entry(row);
	}

	/** Every alias, or a domain's, by address. */
	list(domain?: string): AliasEntry[] {
		const rows =
			domain === undefined
				? this.#db
						.query<AliasRow, []>(
							'SELECT address, domain, created FROM aliases ORDER BY address',
						)
						.all()
				: this.#db
						.query<AliasRow, [string]>(
							'SELECT address, domain, created FROM aliases WHERE domain = ? ORDER BY address',
						)
						.all(checkDomain(domain));
		return rows.map((row) => this.#entry(row));
	}

	/**
	 * Adds an alias in a domain the server hosts, delivering to `targets`,
	 * each a user of this server: `INVALID` for no target, or a target
	 * that is not a local user — an address elsewhere, an alias, an
	 * address nobody has; `NOT_FOUND` for a domain not hosted;
	 * `ALREADY_EXISTS` for an alias or a user at that address.
	 */
	add(address: string, targets: readonly string[]): AliasEntry {
		const { address: key, domain } = checkAddress(address);
		if (targets.length === 0) {
			throw new ServerError('INVALID', 'an alias needs at least one target');
		}
		const users = [
			...new Set(targets.map((target) => checkAddress(target).address)),
		];
		return this.#db
			.transaction(() => {
				requireDomain(this.#db, domain);
				if (this.#row(key) !== undefined) {
					throw new ServerError(
						'ALREADY_EXISTS',
						`the alias ${key} already exists`,
					);
				}
				const user = this.#db.query<unknown, [string]>(
					'SELECT 1 FROM users WHERE address = ?',
				);
				if (user.get(key) !== null) {
					throw new ServerError(
						'ALREADY_EXISTS',
						`${key} is a user; an alias cannot take its address`,
					);
				}
				for (const target of users) {
					if (user.get(target) === null) {
						throw new ServerError(
							'INVALID',
							`${target} is not a user here: an alias points to local users only, never elsewhere`,
						);
					}
				}
				this.#db
					.query(
						'INSERT INTO aliases (address, domain, created) VALUES (?, ?, ?)',
					)
					.run(key, domain, Date.now());
				const insert = this.#db.query(
					'INSERT INTO alias_targets (alias, target) VALUES (?, ?)',
				);
				for (const target of users) insert.run(key, target);
				return this.#entry(this.#row(key) as AliasRow);
			})
			.immediate();
	}

	/** Removes an alias: `NOT_FOUND`. Answers it. */
	remove(address: string): AliasEntry {
		const { address: key } = checkAddress(address);
		return this.#db
			.transaction(() => {
				const row = this.#row(key);
				if (row === undefined) {
					throw new ServerError('NOT_FOUND', `the alias ${key} does not exist`);
				}
				const removed = this.#entry(row);
				this.#db.query('DELETE FROM aliases WHERE address = ?').run(key);
				return removed;
			})
			.immediate();
	}
}
