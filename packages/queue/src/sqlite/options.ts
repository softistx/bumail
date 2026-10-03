/**
 * Where a SQLite queue keeps its items.
 *
 * Apart from `open.ts`, which imports `bun:sqlite`, so the declarations a
 * consumer's `tsc` reads from `@bumail/queue/sqlite` never name it.
 */
export interface SqliteQueueStoreOptions {
	/** Holds `queue.sqlite`; created if need be. */
	readonly directory: string;
	/**
	 * How long a write waits for another process holding the database, in
	 * milliseconds. Default 5000.
	 */
	readonly busyTimeout?: number;
}
