import { QueueError } from '../errors';
import type { Tables } from './connect';
import { writing } from './isolation';
import type { PostgresClient, PostgresQueryable } from './options';
import { rowsOf } from './rows';

/**
 * The migrations, in order, each a list of statements: the schema table's
 * `version` is how many of them the database has run. A migration is
 * never edited once released; a change is a new one at the end. They
 * follow the `bun:sqlite` store's, column for column: times are
 * milliseconds as `double precision` (SQLite's `REAL`), the recipients
 * JSON, the message its bytes, in a table of its own.
 */
export function migrations({
	prefix,
	items,
	messages,
}: Tables): readonly (readonly string[])[] {
	return [
		// 1: the items, and their messages in a table of their own.
		[
			`CREATE TABLE ${items} (
				seq bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
				id text NOT NULL UNIQUE,
				sender text NOT NULL,
				recipients jsonb NOT NULL CHECK (jsonb_typeof(recipients) = 'array'),
				size integer NOT NULL,
				created_at double precision NOT NULL,
				next_attempt_at double precision NOT NULL,
				attempts integer NOT NULL,
				delay_notified boolean NOT NULL,
				lease_owner text,
				lease_expires_at double precision,
				CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL))
			)`,
			// The claim's order, and its range: the earliest due first.
			`CREATE INDEX ${prefix}items_due ON ${items} (next_attempt_at, seq)`,
			`CREATE TABLE ${messages} (
				item_id text PRIMARY KEY REFERENCES ${items} (id) ON DELETE CASCADE,
				content bytea NOT NULL
			)`,
		],
	];
}

/** Tables a newer store wrote, with more migrations than this one knows, are refused. */
function checkNotNewer(version: number, known: number): void {
	if (version > known) {
		throw new QueueError(
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
 * only read: no lock, no DDL, so a worker's role needs no `CREATE`.
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
	// READ COMMITTED, as every write: under a stricter level the version
	// read after the lock would be the snapshot's, from before it.
	await writing(client, async (sql: PostgresQueryable) => {
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
