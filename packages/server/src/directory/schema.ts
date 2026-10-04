import type { Database } from 'bun:sqlite';
import { ServerError } from '../errors';

/**
 * The migrations, in order: the `schema` table's one `version` is how
 * many of them the database has run. A migration is never edited once
 * released; a change is a new one at the end.
 */
export const MIGRATIONS: readonly string[] = [
	// 1: domains, users, aliases and where each alias points.
	`
	CREATE TABLE domains (
		name TEXT PRIMARY KEY,
		created INTEGER NOT NULL
	) STRICT;

	CREATE TABLE users (
		address TEXT PRIMARY KEY,
		domain TEXT NOT NULL REFERENCES domains (name),
		hash TEXT NOT NULL,
		disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
		created INTEGER NOT NULL
	) STRICT;
	CREATE INDEX users_domain ON users (domain);

	CREATE TABLE aliases (
		address TEXT PRIMARY KEY,
		domain TEXT NOT NULL REFERENCES domains (name),
		created INTEGER NOT NULL
	) STRICT;
	CREATE INDEX aliases_domain ON aliases (domain);

	CREATE TABLE alias_targets (
		alias TEXT NOT NULL REFERENCES aliases (address) ON DELETE CASCADE,
		target TEXT NOT NULL REFERENCES users (address),
		PRIMARY KEY (alias, target)
	) STRICT, WITHOUT ROWID;
	CREATE INDEX alias_targets_target ON alias_targets (target);
	`,
	// 2: a user's version, bumped by every change a login depends on, so
	// a process caching a login sees another's change at its next look.
	`
	ALTER TABLE users ADD COLUMN version INTEGER NOT NULL DEFAULT 0;
	`,
];

/**
 * Brings the database to the last migration, in one `IMMEDIATE`
 * transaction, so two processes opening a new file at once migrate it
 * once: a migration that fails leaves the database as it was. A database
 * written by a newer server, with more migrations than this one knows,
 * is refused.
 */
export function migrate(db: Database): void {
	db.transaction(() => {
		db.exec(
			'CREATE TABLE IF NOT EXISTS schema (version INTEGER NOT NULL) STRICT',
		);
		const row = db
			.query<{ version: number }, []>('SELECT version FROM schema')
			.get();
		const version = row?.version ?? 0;
		if (version > MIGRATIONS.length) {
			throw new ServerError(
				'UNAVAILABLE',
				`the directory is at schema version ${version}, newer than this server's ${MIGRATIONS.length}`,
			);
		}
		for (const sql of MIGRATIONS.slice(version)) db.exec(sql);
		if (row === null) {
			db.query('INSERT INTO schema (version) VALUES (?)').run(
				MIGRATIONS.length,
			);
		} else if (version < MIGRATIONS.length) {
			db.query('UPDATE schema SET version = ?').run(MIGRATIONS.length);
		}
	}).immediate();
}
