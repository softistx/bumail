import type { Database } from 'bun:sqlite';
import { QueueError } from '../errors';

/**
 * The migrations, in order: the database's `PRAGMA user_version` is how many
 * of them it has run. A migration is never edited once released; a change
 * is a new one at the end.
 */
export const MIGRATIONS: readonly string[] = [
	// 1: the items, and their messages in a table of their own.
	`
	CREATE TABLE items (
		seq INTEGER PRIMARY KEY,
		id TEXT NOT NULL UNIQUE,
		sender TEXT NOT NULL,
		recipients TEXT NOT NULL CHECK (json_valid(recipients)),
		size INTEGER NOT NULL,
		created_at REAL NOT NULL,
		next_attempt_at REAL NOT NULL,
		attempts INTEGER NOT NULL,
		delay_notified INTEGER NOT NULL,
		lease_owner TEXT,
		lease_expires_at REAL,
		CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
	) STRICT;
	CREATE INDEX items_due ON items (next_attempt_at, seq);

	CREATE TABLE messages (
		item_id TEXT PRIMARY KEY REFERENCES items (id) ON DELETE CASCADE,
		content BLOB NOT NULL
	) STRICT;
	`,
];

/**
 * Brings the database to the last migration, in one transaction: a
 * migration that fails leaves the database as it was. A database written
 * by a newer store, with more migrations than this one knows, is refused.
 */
export function migrate(db: Database): void {
	db.transaction(() => {
		const { user_version: version } = db
			.query<{ user_version: number }, []>('PRAGMA user_version')
			.get() as { user_version: number };
		if (version > MIGRATIONS.length) {
			throw new QueueError(
				'INVALID',
				`The database is at schema version ${version}, newer than this store's ${MIGRATIONS.length}`,
			);
		}
		for (const sql of MIGRATIONS.slice(version)) db.exec(sql);
		if (version < MIGRATIONS.length) {
			db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
		}
	}).immediate();
}
