/**
 * Where a PostgreSQL mail store keeps its mail, and the client it reaches
 * it through.
 *
 * Typed by shape rather than as `Bun.SQL`, so the declarations a
 * consumer's `tsc` reads from `@bumail/store/postgres` name no global of
 * Bun's: a `Bun.SQL` client fits `PostgresClient` (`open.spec.ts` checks
 * it), and so does any client with these methods. It is the shape
 * `@bumail/queue/postgres` takes, so one client serves both.
 */

/** What runs one statement: a client, or the transaction `begin` hands over. */
export interface PostgresQueryable {
	/** One statement, its parameters as `$1`, `$2`, …; resolves with the rows. */
	unsafe(query: string, values?: unknown[]): PromiseLike<unknown>;
}

/** A PostgreSQL client with a pool, such as `new Bun.SQL(url)`. */
export interface PostgresClient extends PostgresQueryable {
	/** Runs `fn` in a transaction on one connection: committed once it resolves, rolled back if it throws. */
	begin(fn: (sql: PostgresQueryable) => Promise<unknown>): PromiseLike<unknown>;
	close(options?: { timeout?: number }): PromiseLike<void>;
}

export interface PostgresMailStoreOptions {
	/**
	 * The database: a client of the application's (`new Bun.SQL(url)`,
	 * which it sizes and closes itself), or a `postgres://` URL, for which
	 * the store opens a client of its own, closed by `close()`.
	 */
	readonly sql: PostgresClient | string | URL;
	/**
	 * Put before each table's name, so several stores, or a store and the
	 * application, share one database: lowercase letters, digits and
	 * underscores, at most 40. Default `bumail_store_`.
	 */
	readonly tablePrefix?: string;
	/**
	 * How many removals an account remembers for the changes. Past it, the
	 * oldest are forgotten, and a `since` before them gets
	 * `CANNOT_CALCULATE_CHANGES`. Default: all of them. Not kept in the
	 * database: give every instance the same.
	 */
	readonly maxTombstones?: number;
}
