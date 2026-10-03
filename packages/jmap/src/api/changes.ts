import { StoreError } from '@bumail/store';
import { type Args, accountOf, onlyKnown, uintOf } from './args';
import type { CallContext } from './context';
import { invalidArguments, MethodError } from './errors';
import { sinceOf } from './state';

/** What a store answers for changes since a modseq. */
export interface StoreChanges {
	readonly modseq: number;
	readonly hasMore: boolean;
	readonly created: readonly string[];
	readonly updated: readonly string[];
	readonly destroyed: readonly string[];
}

/** RFC 8620 §5.2 `/changes`, on a store's changes since a modseq. */
export async function changes(
	args: Args,
	ctx: CallContext,
	read: (since: number, limit: number | undefined) => Promise<StoreChanges>,
	extra: Args = {},
): Promise<Args> {
	onlyKnown(args, ['accountId', 'sinceState', 'maxChanges']);
	const accountId = accountOf(args, ctx);
	const since = sinceOf(args['sinceState']);
	const maxChanges = uintOf(args, 'maxChanges');
	if (maxChanges === 0)
		throw invalidArguments('maxChanges must be more than 0');
	let found: StoreChanges;
	try {
		found = await read(since, maxChanges);
	} catch (error) {
		if (error instanceof StoreError && error.code === 'INVALID') {
			throw new MethodError(
				'cannotCalculateChanges',
				'The state is not one this server gave',
			);
		}
		throw error;
	}
	return {
		accountId,
		oldState: String(since),
		newState: String(found.modseq),
		hasMoreChanges: found.hasMore,
		created: found.created,
		updated: found.updated,
		destroyed: found.destroyed,
		...extra,
	};
}
