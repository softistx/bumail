import { isObject } from './args';
import { invalidArguments, MethodError } from './errors';

/** A filter tree (RFC 8620 §5.5): operators over conditions. */
export type Filter<C> =
	| {
			readonly operator: 'AND' | 'OR' | 'NOT';
			readonly conditions: readonly Filter<C>[];
	  }
	| { readonly condition: C };

/** How deep operators nest, and how many conditions a filter holds. */
const MAX_DEPTH = 16;
const MAX_NODES = 256;

/** The `filter` argument as a tree, each condition read by `read`; `undefined` when absent. */
export function filterOf<C>(
	value: unknown,
	read: (condition: Record<string, unknown>) => C,
): Filter<C> | undefined {
	if (value === undefined || value === null) return undefined;
	let nodes = 0;
	const walk = (node: unknown, depth: number): Filter<C> => {
		if (++nodes > MAX_NODES) {
			throw new MethodError(
				'unsupportedFilter',
				`The filter holds more than ${MAX_NODES} conditions`,
			);
		}
		if (!isObject(node)) throw invalidArguments('A filter is an object');
		if (!('operator' in node)) return { condition: read(node) };
		const { operator, conditions } = node;
		if (operator !== 'AND' && operator !== 'OR' && operator !== 'NOT') {
			throw new MethodError('unsupportedFilter', 'operator is AND, OR or NOT');
		}
		if (!Array.isArray(conditions) || Object.keys(node).length !== 2) {
			throw invalidArguments(
				'A FilterOperator has an operator and conditions only',
			);
		}
		if (depth >= MAX_DEPTH) {
			throw new MethodError(
				'unsupportedFilter',
				`Operators nest deeper than ${MAX_DEPTH}`,
			);
		}
		return { operator, conditions: conditions.map((c) => walk(c, depth + 1)) };
	};
	return walk(value, 0);
}

/** Whether an item matches a filter; `test` checks one condition. */
export async function matches<C, T>(
	filter: Filter<C> | undefined,
	item: T,
	test: (condition: C, item: T) => boolean | Promise<boolean>,
): Promise<boolean> {
	if (filter === undefined) return true;
	if ('condition' in filter) return test(filter.condition, item);
	switch (filter.operator) {
		case 'AND':
			for (const c of filter.conditions)
				if (!(await matches(c, item, test))) return false;
			return true;
		case 'OR':
			for (const c of filter.conditions)
				if (await matches(c, item, test)) return true;
			return false;
		default:
			for (const c of filter.conditions)
				if (await matches(c, item, test)) return false;
			return true;
	}
}
