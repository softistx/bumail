import type { Database } from 'bun:sqlite';
import { ServerError } from '../errors';
import { checkDomain, domainOf } from './address';

/** A domain the server hosts. */
export interface DomainEntry {
	/** Lowercase, in A-labels. */
	readonly name: string;
	readonly created: Date;
	/** Its users, disabled ones included. */
	readonly users: number;
	readonly aliases: number;
}

interface DomainRow {
	name: string;
	created: number;
	users: number;
	aliases: number;
}

const SELECT = `
	SELECT name, created,
		(SELECT count(*) FROM users WHERE domain = name) AS users,
		(SELECT count(*) FROM aliases WHERE domain = name) AS aliases
	FROM domains`;

function entry(row: DomainRow): DomainEntry {
	return {
		name: row.name,
		created: new Date(row.created),
		users: row.users,
		aliases: row.aliases,
	};
}

/** `2 users and 1 alias`, leaving out what is 0. */
function holding(row: DomainRow): string {
	const parts: string[] = [];
	if (row.users > 0)
		parts.push(`${row.users} user${row.users === 1 ? '' : 's'}`);
	if (row.aliases > 0) {
		parts.push(`${row.aliases} alias${row.aliases === 1 ? '' : 'es'}`);
	}
	return parts.join(' and ');
}

/** The domains the server receives mail for. */
export class Domains {
	readonly #db: Database;

	constructor(db: Database) {
		this.#db = db;
	}

	#get(name: string): DomainRow | undefined {
		return (
			this.#db
				.query<DomainRow, [string]>(`${SELECT} WHERE name = ?`)
				.get(name) ?? undefined
		);
	}

	/** Whether the server hosts `name`, matched without case; `false` for what is not a domain name. */
	has(name: string): boolean {
		const domain = domainOf(name);
		if (domain === undefined) return false;
		return (
			this.#db
				.query<unknown, [string]>('SELECT 1 FROM domains WHERE name = ?')
				.get(domain) !== null
		);
	}

	/** The domain, or `undefined`. */
	get(name: string): DomainEntry | undefined {
		const domain = domainOf(name);
		const row = domain === undefined ? undefined : this.#get(domain);
		return row === undefined ? undefined : entry(row);
	}

	/** Every domain, by name. */
	list(): DomainEntry[] {
		return this.#db
			.query<DomainRow, []>(`${SELECT} ORDER BY name`)
			.all()
			.map(entry);
	}

	/** Adds a domain: `INVALID` for what is not a domain name, `ALREADY_EXISTS`. */
	add(name: string): DomainEntry {
		const domain = checkDomain(name);
		return this.#db
			.transaction(() => {
				if (this.#get(domain) !== undefined) {
					throw new ServerError(
						'ALREADY_EXISTS',
						`the domain ${domain} already exists`,
					);
				}
				this.#db
					.query('INSERT INTO domains (name, created) VALUES (?, ?)')
					.run(domain, Date.now());
				return entry(this.#get(domain) as DomainRow);
			})
			.immediate();
	}

	/** Removes a domain with no user and no alias left: `NOT_FOUND`, `IN_USE`. Answers its name. */
	remove(name: string): string {
		const domain = checkDomain(name);
		this.#db
			.transaction(() => {
				const row = this.#get(domain);
				if (row === undefined) {
					throw new ServerError(
						'NOT_FOUND',
						`the domain ${domain} does not exist`,
					);
				}
				if (row.users > 0 || row.aliases > 0) {
					throw new ServerError(
						'IN_USE',
						`the domain ${domain} still has ${holding(row)}; remove them first`,
					);
				}
				this.#db.query('DELETE FROM domains WHERE name = ?').run(domain);
			})
			.immediate();
		return domain;
	}
}

/** `NOT_FOUND` unless the server hosts `domain`, read inside the caller's transaction. */
export function requireDomain(db: Database, domain: string): void {
	const found = db
		.query<unknown, [string]>('SELECT 1 FROM domains WHERE name = ?')
		.get(domain);
	if (found === null) {
		throw new ServerError(
			'NOT_FOUND',
			`the domain ${domain} is not hosted here; add it first`,
		);
	}
}
