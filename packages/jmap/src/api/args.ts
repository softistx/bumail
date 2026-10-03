import { ID, isId, quoted } from '../shared/text';
import type { CallContext } from './context';
import { invalidArguments, MethodError } from './errors';

export type Args = Record<string, unknown>;

export const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The call's `accountId`: only the authenticated account is ever found, so
 * no call reaches another account's data, whatever id it names.
 */
export function accountOf(args: Args, ctx: CallContext): string {
	const { accountId } = args;
	if (typeof accountId !== 'string') {
		throw invalidArguments('accountId is required');
	}
	if (accountId !== ctx.accountId) {
		throw new MethodError('accountNotFound');
	}
	return accountId;
}

/** An id, or a `#creationId` of an object created earlier in the request. */
export function idOf(value: unknown, ctx: CallContext): string | undefined {
	if (typeof value === 'string' && value.startsWith('#')) {
		return ctx.created.get(value.slice(1));
	}
	return isId(value) ? value : undefined;
}

/** A list of ids, `null` when absent; `#creationId`s resolved, unknown ones kept to be not found. */
export function idsOf(
	args: Args,
	name: string,
	ctx: CallContext,
	max: number,
): string[] | null {
	const value = args[name];
	if (value === undefined || value === null) return null;
	if (!Array.isArray(value))
		throw invalidArguments(`${name} must be an array of ids`);
	if (value.length > max) {
		throw new MethodError(
			'requestTooLarge',
			`${name} holds more than ${max} ids`,
		);
	}
	return value.map((item) => {
		if (typeof item !== 'string' || !(ID.test(item) || item.startsWith('#'))) {
			throw invalidArguments(
				`${name} holds ${quoted(item)}, which is not an id`,
			);
		}
		return idOf(item, ctx) ?? item;
	});
}

/** The properties asked for: `null` or absent gives the defaults; an unknown one is refused. */
export function propertiesOf(
	args: Args,
	name: string,
	known: (property: string) => boolean,
	defaults: readonly string[],
): string[] {
	const value = args[name];
	if (value === undefined || value === null) return [...defaults];
	if (!Array.isArray(value) || value.length > 256) {
		throw invalidArguments(
			`${name} must be an array of at most 256 property names`,
		);
	}
	for (const property of value) {
		if (typeof property !== 'string' || !known(property)) {
			throw invalidArguments(
				`${name} names ${quoted(property)}, which is not a property`,
			);
		}
	}
	return [...new Set(value as string[])];
}

export function boolOf(args: Args, name: string, fallback = false): boolean {
	const value = args[name];
	if (value === undefined || value === null) return fallback;
	if (typeof value !== 'boolean')
		throw invalidArguments(`${name} must be a boolean`);
	return value;
}

/** An UnsignedInt, or `undefined` when absent. */
export function uintOf(args: Args, name: string): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
		throw invalidArguments(`${name} must be an unsigned integer`);
	}
	return value;
}

/** An Int, or `undefined` when absent. */
export function intOf(args: Args, name: string): number | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
		throw invalidArguments(`${name} must be an integer`);
	}
	return value;
}

export function stringOf(args: Args, name: string): string | undefined {
	const value = args[name];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== 'string')
		throw invalidArguments(`${name} must be a string`);
	return value;
}

/** Arguments a method does not know are refused (RFC 8620 §3.6.2 `invalidArguments`). */
export function onlyKnown(args: Args, known: readonly string[]): void {
	for (const key of Object.keys(args)) {
		if (!known.includes(key)) {
			throw invalidArguments(`Unknown argument ${quoted(key)}`);
		}
	}
}
