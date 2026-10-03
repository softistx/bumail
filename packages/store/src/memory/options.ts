export interface MemoryMailStoreOptions {
	/**
	 * How many removals an account remembers for the changes. Past it, the
	 * oldest are forgotten, and a `since` before them gets
	 * `CANNOT_CALCULATE_CHANGES`. Default: all of them.
	 */
	readonly maxTombstones?: number;
}
