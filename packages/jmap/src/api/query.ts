import { type Args, intOf, stringOf, uintOf } from './args';
import { invalidArguments, MethodError } from './errors';

/** The page of a query's ids (RFC 8620 §5.5): position, anchor, limit and total. */
export function pageOf(
	ids: readonly string[],
	args: Args,
	maxLimit: number,
): Args {
	const limit = uintOf(args, 'limit');
	const anchor = stringOf(args, 'anchor');
	let position = intOf(args, 'position') ?? 0;
	if (anchor !== undefined) {
		const index = ids.indexOf(anchor);
		if (index < 0) throw new MethodError('anchorNotFound');
		position = Math.max(0, index + (intOf(args, 'anchorOffset') ?? 0));
	} else if (position < 0) {
		position = Math.max(0, ids.length + position);
	}
	const taken = Math.min(limit ?? maxLimit, maxLimit);
	return {
		position,
		ids: ids.slice(position, position + taken),
		...(args['calculateTotal'] === true ? { total: ids.length } : {}),
		...(limit !== undefined && limit > maxLimit ? { limit: maxLimit } : {}),
	};
}

/** A Comparator (RFC 8620 §5.5), checked. */
export interface Comparator {
	readonly property: string;
	readonly isAscending: boolean;
}

/** The collation this server sorts and compares text by. */
export const COLLATION = 'i;unicode-casemap';

/** The `sort` argument: each property one of `known`, else `unsupportedSort`. */
export function sortOf(value: unknown, known: readonly string[]): Comparator[] {
	if (value === undefined || value === null) return [];
	if (!Array.isArray(value) || value.length > 16) {
		throw invalidArguments('sort must be an array of at most 16 comparators');
	}
	return value.map((item) => {
		if (
			typeof item !== 'object' ||
			item === null ||
			typeof item.property !== 'string'
		) {
			throw invalidArguments('A comparator is an object with a property');
		}
		const { property, isAscending = true, collation } = item as Args;
		if (!known.includes(property as string)) {
			throw new MethodError(
				'unsupportedSort',
				`Sorting by ${JSON.stringify(String(property).slice(0, 100))} is not supported`,
			);
		}
		if (collation !== undefined && collation !== COLLATION) {
			throw new MethodError(
				'unsupportedSort',
				`Only the ${COLLATION} collation is supported`,
			);
		}
		if (typeof isAscending !== 'boolean') {
			throw invalidArguments('isAscending must be a boolean');
		}
		return { property: property as string, isAscending };
	});
}

/** Text compared as `i;unicode-casemap` does, near enough: case folded, then by code point. */
export function compareText(a: string, b: string): number {
	const x = a.toLowerCase();
	const y = b.toLowerCase();
	return x < y ? -1 : x > y ? 1 : 0;
}
