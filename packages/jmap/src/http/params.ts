import type { StandardIssue, StandardSchemaV1 } from '@alxia/core';
import { isId } from '../shared/text';

export const ACCOUNT_NOT_FOUND = 'No account has this id';
export const BLOB_NOT_FOUND = 'No blob has this id';

type Params<Name extends string> = { readonly [Key in Name]: string };

/**
 * The schema of a route's path parameters: those named in `ids` must be
 * RFC 8620 §1.2 Ids, those in `rest` any text. A parameter it refuses is a
 * `validation` refusal of the `params`, which the route's `onRefusal`
 * answers.
 */
export function idParams<
	const Id extends string,
	const Rest extends string = never,
>(
	ids: readonly Id[],
	rest: readonly Rest[] = [],
): StandardSchemaV1<Params<Id | Rest>, Params<Id | Rest>> {
	return {
		'~standard': {
			version: 1,
			vendor: 'bumail',
			validate(value) {
				const input = (value ?? {}) as Record<string, unknown>;
				const issues: StandardIssue[] = [];
				const output: Record<string, string> = {};
				for (const name of ids) {
					if (isId(input[name])) output[name] = input[name];
					else issues.push({ message: `${name} is not an Id`, path: [name] });
				}
				for (const name of rest) output[name] = String(input[name] ?? '');
				return issues.length > 0
					? { issues }
					: { value: output as Params<Id | Rest> };
			},
		},
	};
}
