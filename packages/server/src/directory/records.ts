import type { Database } from 'bun:sqlite';
import { addressOf } from './address';

/** A user: an address that logs in and has a mailbox. */
export interface UserEntry {
	/** `local@domain`, lowercase. */
	readonly address: string;
	readonly domain: string;
	/** A disabled user cannot log in; mail for it is still delivered. */
	readonly disabled: boolean;
	readonly created: Date;
}

export interface UserRow {
	address: string;
	domain: string;
	disabled: number;
	created: number;
}

/** A user, with what `authenticate` checks. */
export interface UserRecord extends UserEntry {
	readonly hash: string;
	/** Bumped by a new password, a disable and an enable. */
	readonly version: number;
}

export function entry(row: UserRow): UserEntry {
	return {
		address: row.address,
		domain: row.domain,
		disabled: row.disabled === 1,
		created: new Date(row.created),
	};
}

export const COLUMNS = 'address, domain, disabled, created';

/**
 * The user at any spelling of `address`, with its hash, for
 * `authenticate` alone: kept out of `Users`, so nothing exported hands a
 * hash out.
 */
export function findRecord(
	db: Database,
	address: string,
): UserRecord | undefined {
	const parsed = addressOf(address);
	if (parsed === undefined) return undefined;
	const row = db
		.query<UserRow & { hash: string; version: number }, [string]>(
			`SELECT ${COLUMNS}, hash, version FROM users WHERE address = ?`,
		)
		.get(parsed.address);
	return row === null
		? undefined
		: { ...entry(row), hash: row.hash, version: row.version };
}

/**
 * The version of the user at `address`, as kept (lowercase), or
 * `undefined` when there is none: what a cached login is checked
 * against, one indexed read.
 */
export function userVersion(db: Database, address: string): number | undefined {
	const row = db
		.query<{ version: number }, [string]>(
			'SELECT version FROM users WHERE address = ?',
		)
		.get(address);
	return row?.version;
}

/** A version no earlier user at the address is likely to have had: 48 random bits. */
export function randomVersion(): number {
	const [high = 0, low = 0] = crypto.getRandomValues(new Uint32Array(2));
	return (high & 0xffff) * 2 ** 32 + low;
}
