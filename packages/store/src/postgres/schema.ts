import { StoreError } from '../errors';
import type { Tables } from './connect';
import type { PostgresClient, PostgresQueryable } from './options';
import { rowsOf } from './rows';

/** The counters shared by every account: the next UIDVALIDITY. */
const countersTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.counters} (
		name text CONSTRAINT ${p}counters_pkey PRIMARY KEY,
		value bigint NOT NULL
	)`,
];

/** The accounts, each with its modseq and the floor of the changes it can tell. */
const accountsTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.accounts} (
		id text CONSTRAINT ${p}accounts_pkey PRIMARY KEY,
		name text NOT NULL,
		login_key text NOT NULL CONSTRAINT ${p}accounts_login UNIQUE,
		modseq bigint NOT NULL DEFAULT 0,
		floor bigint NOT NULL DEFAULT 0
	)`,
];

/** The mailboxes, with their UIDs and modseqs. */
const mailboxesTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.mailboxes} (
		id text CONSTRAINT ${p}mailboxes_pkey PRIMARY KEY,
		account_id text NOT NULL CONSTRAINT ${p}mailboxes_account_fk
			REFERENCES ${t.accounts} (id) ON DELETE CASCADE,
		name text NOT NULL,
		parent_id text CONSTRAINT ${p}mailboxes_parent_fk
			REFERENCES ${t.mailboxes} (id) DEFERRABLE INITIALLY DEFERRED,
		role text,
		is_subscribed boolean NOT NULL,
		uid_validity bigint NOT NULL CONSTRAINT ${p}mailboxes_validity UNIQUE,
		uid_next bigint NOT NULL,
		created_modseq bigint NOT NULL,
		modseq bigint NOT NULL,
		highest_modseq bigint NOT NULL
	)`,

	`CREATE UNIQUE INDEX ${p}mailboxes_place
		ON ${t.mailboxes} (account_id, coalesce(parent_id, ''), name)`,

	`CREATE UNIQUE INDEX ${p}mailboxes_role
		ON ${t.mailboxes} (account_id, role) WHERE role IS NOT NULL`,

	`CREATE INDEX ${p}mailboxes_parent ON ${t.mailboxes} (parent_id)`,
];

/** An account's content, once per distinct bytes, counted by the messages that use it. */
const contentsTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.contents} (
		account_id text NOT NULL CONSTRAINT ${p}contents_account_fk
			REFERENCES ${t.accounts} (id) ON DELETE CASCADE,
		blob_id text NOT NULL,
		uses integer NOT NULL CONSTRAINT ${p}contents_uses CHECK (uses > 0),
		size bigint NOT NULL,
		content bytea NOT NULL,
		CONSTRAINT ${p}contents_pkey PRIMARY KEY (account_id, blob_id)
	)`,
];

/** The messages, by account, with their flags and modseqs. */
const messagesTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.messages} (
		id text CONSTRAINT ${p}messages_pkey PRIMARY KEY,
		account_id text NOT NULL CONSTRAINT ${p}messages_account_fk
			REFERENCES ${t.accounts} (id) ON DELETE CASCADE,
		thread_id text NOT NULL,
		blob_id text NOT NULL,
		size bigint NOT NULL,
		flags jsonb NOT NULL
			CONSTRAINT ${p}messages_flags CHECK (jsonb_typeof(flags) = 'array'),
		received_at bigint NOT NULL,
		created_modseq bigint NOT NULL,
		modseq bigint NOT NULL,
		CONSTRAINT ${p}messages_content_fk FOREIGN KEY (account_id, blob_id)
			REFERENCES ${t.contents} (account_id, blob_id)
	)`,

	`CREATE INDEX ${p}messages_created ON ${t.messages} (account_id, created_modseq)`,

	`CREATE INDEX ${p}messages_changed ON ${t.messages} (account_id, modseq)`,

	`CREATE INDEX ${p}messages_content ON ${t.messages} (account_id, blob_id)`,
];

/** Which mailboxes hold a message, and under which UID. */
const membershipsTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.memberships} (
		mailbox_id text NOT NULL CONSTRAINT ${p}memberships_mailbox_fk
			REFERENCES ${t.mailboxes} (id) ON DELETE CASCADE,
		uid bigint NOT NULL,
		message_id text NOT NULL CONSTRAINT ${p}memberships_message_fk
			REFERENCES ${t.messages} (id) ON DELETE CASCADE,
		joined_modseq bigint NOT NULL,
		CONSTRAINT ${p}memberships_pkey PRIMARY KEY (mailbox_id, uid)
	)`,

	`CREATE UNIQUE INDEX ${p}memberships_message
		ON ${t.memberships} (message_id, mailbox_id)`,
];

/** What was removed, for the changes. */
const tombstonesTable = (t: Tables, p = t.prefix): string[] => [
	`CREATE TABLE ${t.tombstones} (
		seq bigint GENERATED ALWAYS AS IDENTITY
			CONSTRAINT ${p}tombstones_pkey PRIMARY KEY,
		account_id text NOT NULL CONSTRAINT ${p}tombstones_account_fk
			REFERENCES ${t.accounts} (id) ON DELETE CASCADE,
		kind text NOT NULL CONSTRAINT ${p}tombstones_kind
			CHECK (kind IN ('message', 'mailbox', 'expunged')),
		modseq bigint NOT NULL,
		id text NOT NULL,
		created_modseq bigint NOT NULL,
		mailbox_id text,
		uid bigint,
		joined_modseq bigint,
		CONSTRAINT ${p}tombstones_shape
			CHECK ((kind = 'expunged') = (joined_modseq IS NOT NULL))
	)`,

	`CREATE INDEX ${p}tombstones_since ON ${t.tombstones} (account_id, kind, modseq)`,

	`CREATE INDEX ${p}tombstones_mailbox
		ON ${t.tombstones} (account_id, kind, mailbox_id, modseq)`,

	`CREATE INDEX ${p}tombstones_account ON ${t.tombstones} (account_id, seq)`,
];

/**
 * The migrations, in order, each a list of statements: the schema table's
 * `version` is how many of them the database has run. A migration is
 * never edited once released; a change is a new one at the end. They
 * follow the `bun:sqlite` store's, column for column, but for the content,
 * which is `bytea` in a table of its own rather than files. Every index
 * and constraint is named, so a prefix of 40 still fits PostgreSQL's 63.
 */
export function migrations(t: Tables): readonly (readonly string[])[] {
	return [
		// 1: the whole store.
		[
			...countersTable(t),
			...accountsTable(t),
			...mailboxesTable(t),
			...contentsTable(t),
			...messagesTable(t),
			...membershipsTable(t),
			...tombstonesTable(t),
		],
	];
}

/**
 * Before the first migration, none of the store's tables may be there, nor
 * a `<prefix>schema`: one that is belongs to something else given the
 * same prefix, such as a `@bumail/queue/postgres` queue, whose `schema`
 * and `messages` tables have those names. Refused, rather than share a
 * table or fail on PostgreSQL's `already exists`.
 */
async function checkNoneTaken(
	sql: PostgresQueryable,
	tables: Tables,
): Promise<void> {
	const names = [
		`${tables.prefix}schema`,
		tables.counters,
		tables.accounts,
		tables.mailboxes,
		tables.contents,
		tables.messages,
		tables.memberships,
		tables.tombstones,
	];
	const [taken] = await rowsOf<{ name: string }>(
		sql.unsafe(
			`SELECT name FROM jsonb_array_elements_text($1::text::jsonb) WITH ORDINALITY AS n(name, i)
			WHERE to_regclass(name) IS NOT NULL ORDER BY i LIMIT 1`,
			[JSON.stringify(names)],
		),
	);
	if (taken) {
		throw new StoreError(
			'INVALID',
			`The table "${taken.name}" is already in the database, and is not the mail store's: give the store a tablePrefix of its own`,
		);
	}
}

/** Tables a newer store wrote, with more migrations than this one knows, are refused. */
function checkNotNewer(version: number, known: number): void {
	if (version > known) {
		throw new StoreError(
			'INVALID',
			`The database is at schema version ${version}, newer than this store's ${known}`,
		);
	}
}

/**
 * The version the tables are at, read with no lock and no DDL — so a role
 * with no `CREATE` reads it — or `undefined` with no schema table yet.
 */
async function versionOf(
	client: PostgresClient,
	tables: Tables,
): Promise<number | undefined> {
	return (await client.begin(async (sql) => {
		// Explicit, whatever the client's default: a read-only REPEATABLE
		// READ never ends in a serialization failure.
		await sql.unsafe(
			'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY',
		);
		return versionIn(sql, tables);
	})) as number | undefined;
}

async function versionIn(
	sql: PostgresQueryable,
	tables: Tables,
): Promise<number | undefined> {
	const [found] = await rowsOf<{ present: boolean }>(
		sql.unsafe('SELECT to_regclass($1) IS NOT NULL AS present', [
			tables.schema,
		]),
	);
	if (!found?.present) return undefined;
	const [row] = await rowsOf<{ version: number }>(
		sql.unsafe(`SELECT version FROM ${tables.schema}`),
	);
	return row?.version ?? 0;
}

/**
 * Brings the tables to the last migration. Tables already current are
 * only read: no lock, no DDL, so a server's role needs no `CREATE`.
 * Otherwise in one transaction — a migration that fails leaves them as
 * they were — under one advisory lock, so instances starting together
 * run each migration once.
 */
export async function migrate(
	client: PostgresClient,
	tables: Tables,
): Promise<void> {
	const all = migrations(tables);
	const current = await versionOf(client, tables);
	if (current !== undefined) {
		checkNotNewer(current, all.length);
		if (current === all.length) return;
	}
	await client.begin(async (sql: PostgresQueryable) => {
		// READ COMMITTED whatever the client's default, so the statements
		// after the lock see what the instance that held it committed: a
		// snapshot taken before it would read version 0 again.
		await sql.unsafe(
			'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE',
		);
		await sql.unsafe('SELECT pg_advisory_xact_lock(hashtext($1)) IS NULL', [
			tables.schema,
		]);
		await sql.unsafe(
			`CREATE TABLE IF NOT EXISTS ${tables.schema} (version integer NOT NULL)`,
		);
		const [row] = await rowsOf<{ version: number }>(
			sql.unsafe(`SELECT version FROM ${tables.schema}`),
		);
		const version = row?.version ?? 0;
		checkNotNewer(version, all.length);
		if (version === 0) await checkNoneTaken(sql, tables);
		for (const statements of all.slice(version)) {
			for (const statement of statements) await sql.unsafe(statement);
		}
		if (row === undefined) {
			await sql.unsafe(
				`INSERT INTO ${tables.schema} (version) VALUES ($1::int)`,
				[all.length],
			);
		} else if (version < all.length) {
			await sql.unsafe(`UPDATE ${tables.schema} SET version = $1::int`, [
				all.length,
			]);
		}
	});
}
