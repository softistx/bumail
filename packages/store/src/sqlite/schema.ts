import type { Database } from 'bun:sqlite';
import { StoreError } from '../errors';

/**
 * The migrations, in order: the database's `PRAGMA user_version` is how many
 * of them it has run. A migration is never edited once released; a change
 * is a new one at the end.
 */
export const MIGRATIONS: readonly string[] = [
	// 1: accounts, mailboxes, what is gone, and the store's own counters.
	`
	CREATE TABLE counters (
		name TEXT PRIMARY KEY,
		value INTEGER NOT NULL
	) STRICT;

	CREATE TABLE accounts (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		login_key TEXT NOT NULL UNIQUE,
		modseq INTEGER NOT NULL DEFAULT 0,
		floor INTEGER NOT NULL DEFAULT 0
	) STRICT;

	CREATE TABLE mailboxes (
		id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
		name TEXT NOT NULL,
		parent_id TEXT REFERENCES mailboxes (id) DEFERRABLE INITIALLY DEFERRED,
		role TEXT,
		is_subscribed INTEGER NOT NULL,
		uid_validity INTEGER NOT NULL UNIQUE,
		uid_next INTEGER NOT NULL,
		created_modseq INTEGER NOT NULL,
		modseq INTEGER NOT NULL,
		highest_modseq INTEGER NOT NULL
	) STRICT;
	CREATE UNIQUE INDEX mailboxes_place
		ON mailboxes (account_id, coalesce(parent_id, ''), name);
	CREATE UNIQUE INDEX mailboxes_role
		ON mailboxes (account_id, role) WHERE role IS NOT NULL;
	CREATE INDEX mailboxes_parent ON mailboxes (parent_id);

	CREATE TABLE tombstones (
		seq INTEGER PRIMARY KEY,
		account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
		kind TEXT NOT NULL CHECK (kind IN ('message', 'mailbox', 'expunged')),
		modseq INTEGER NOT NULL,
		id TEXT NOT NULL,
		created_modseq INTEGER NOT NULL,
		mailbox_id TEXT,
		uid INTEGER,
		joined_modseq INTEGER,
		CHECK ((kind = 'expunged') = (joined_modseq IS NOT NULL))
	) STRICT;
	CREATE INDEX tombstones_since ON tombstones (account_id, kind, modseq);
	CREATE INDEX tombstones_mailbox
		ON tombstones (account_id, kind, mailbox_id, modseq);
	`,
	// 2: messages, where they are, and which account holds which blob.
	`
	CREATE TABLE account_blobs (
		account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
		blob_id TEXT NOT NULL,
		uses INTEGER NOT NULL CHECK (uses > 0),
		PRIMARY KEY (account_id, blob_id)
	) STRICT, WITHOUT ROWID;
	CREATE INDEX account_blobs_blob ON account_blobs (blob_id);

	CREATE TABLE messages (
		id TEXT PRIMARY KEY,
		account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
		thread_id TEXT NOT NULL,
		blob_id TEXT NOT NULL,
		size INTEGER NOT NULL,
		flags TEXT NOT NULL CHECK (json_valid(flags)),
		received_at INTEGER NOT NULL,
		created_modseq INTEGER NOT NULL,
		modseq INTEGER NOT NULL,
		FOREIGN KEY (account_id, blob_id)
			REFERENCES account_blobs (account_id, blob_id)
	) STRICT;
	CREATE INDEX messages_created ON messages (account_id, created_modseq);
	CREATE INDEX messages_changed ON messages (account_id, modseq);

	CREATE TABLE memberships (
		mailbox_id TEXT NOT NULL REFERENCES mailboxes (id) ON DELETE CASCADE,
		uid INTEGER NOT NULL,
		message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
		joined_modseq INTEGER NOT NULL,
		PRIMARY KEY (mailbox_id, uid)
	) STRICT, WITHOUT ROWID;
	CREATE UNIQUE INDEX memberships_message
		ON memberships (message_id, mailbox_id);

	CREATE INDEX tombstones_account ON tombstones (account_id, seq);
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
			throw new StoreError(
				'INVALID',
				`The database is at schema version ${version}, newer than this store's ${MIGRATIONS.length}`,
			);
		}
		for (const sql of MIGRATIONS.slice(version)) db.exec(sql);
		if (version < MIGRATIONS.length) {
			db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
		}
	}).exclusive();
}
