import type { PostgresClient, PostgresQueryable } from './options';
import { rowsOf } from './rows';

/**
 * The first statement of every transaction that writes: READ COMMITTED
 * whatever the client's sessions default to. The claim's `FOR UPDATE SKIP
 * LOCKED` and the `maxItems` advisory lock count on it: under `repeatable
 * read` or `serializable`, a row another transaction changed since the
 * snapshot fails with SQLSTATE 40001, and the count taken after the lock
 * would read a snapshot from before it.
 */
const READ_COMMITTED =
	'SET TRANSACTION ISOLATION LEVEL READ COMMITTED, READ WRITE';

/** `fn` in a transaction at READ COMMITTED: every write of the store, its migration included, goes through here. */
export async function writing<T>(
	sql: PostgresClient,
	fn: (tx: PostgresQueryable) => Promise<T>,
): Promise<T> {
	return (await sql.begin(async (tx: PostgresQueryable) => {
		await tx.unsafe(READ_COMMITTED);
		return fn(tx);
	})) as T;
}

/** One statement that writes, at READ COMMITTED; its rows. */
export function written<T>(
	sql: PostgresClient,
	query: string,
	values: unknown[] = [],
): Promise<T[]> {
	return writing(sql, (tx) => rowsOf<T>(tx.unsafe(query, values)));
}
