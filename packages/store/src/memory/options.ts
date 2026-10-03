import { StoreError } from '../errors';

export interface MemoryMailStoreOptions {
	/**
	 * How many removals an account remembers for the changes. Past it, the
	 * oldest are forgotten, and a `since` before them gets
	 * `CANNOT_CALCULATE_CHANGES`. Default: all of them.
	 */
	readonly maxTombstones?: number;
}

/** The tombstones to keep: `Infinity` by default; refuses anything but a count. */
export function maxTombstones(options: MemoryMailStoreOptions): number {
	const max = options.maxTombstones ?? Number.POSITIVE_INFINITY;
	if (
		!(
			max === Number.POSITIVE_INFINITY ||
			(Number.isSafeInteger(max) && max >= 0)
		)
	) {
		throw new StoreError(
			'INVALID',
			`maxTombstones must be an integer of at least 0, not ${max}`,
		);
	}
	return max;
}
