import type { Tables } from './connect';

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
