import { StoreError } from '../errors';
import type { Tables } from './connect';
import type { PostgresClient, PostgresQueryable } from './options';
import { rowsOf } from './rows';
import { migrations } from './tables';

export { migrations } from './tables';

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
