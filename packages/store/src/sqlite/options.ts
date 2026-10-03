/**
 * Where a store keeps its mail: one directory, for one process at a time.
 *
 * Apart from `open.ts`, which imports `bun:sqlite`, so the declarations a
 * consumer's `tsc` reads from `@bumail/store/sqlite` never name it.
 */
export interface SqliteMailStoreOptions {
	/** Holds `mail.sqlite` and `blobs/`; created if need be. */
	readonly directory: string;
	/**
	 * How many removals an account remembers for the changes. Past it, the
	 * oldest are forgotten, and a `since` before them gets
	 * `CANNOT_CALCULATE_CHANGES`. Default: all of them.
	 */
	readonly maxTombstones?: number;
}
