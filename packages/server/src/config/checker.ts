import type { ConfigProblem } from '../errors';
import { didYouMean } from './suggest';

/** A TOML table, as `Bun.TOML.parse` gives it. */
export type Table = Readonly<Record<string, unknown>>;

/** Keys refused wherever they appear: each would let mail through unauthenticated. */
export const RELAY_KEYS: ReadonlySet<string> = new Set([
	'relay',
	'mynetworks',
	'trustedNetworks',
]);

/** What a value is, in words, without ever repeating it. */
export function describe(value: unknown): string {
	if (typeof value === 'string') return 'a string';
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'an integer' : 'a number';
	}
	if (typeof value === 'boolean') return 'a boolean';
	if (Array.isArray(value)) return 'an array';
	if (isTable(value)) return 'a table';
	return 'a date';
}

export function isTable(value: unknown): value is Table {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		Object.getPrototypeOf(value) === Object.prototype
	);
}

/** A key as it is written in a dotted path: bare when TOML allows it, quoted otherwise. */
export function keyPath(parent: string, key: string): string {
	const part = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
	return parent === '' ? part : `${parent}.${part}`;
}

/**
 * Collects every problem of a configuration instead of stopping at the
 * first, and reads its values by type. A reader that finds a problem
 * records it and answers `undefined`, so the caller goes on with the
 * default and finds the next one. No problem it records repeats a value.
 */
export class Checker {
	readonly problems: ConfigProblem[] = [];

	add(path: string, problem: string): void {
		this.problems.push({ path, problem });
	}

	/**
	 * The table at `path`, its keys checked against `known`: a key in
	 * `RELAY_KEYS` is refused as such, any other unknown one with the
	 * closest known key. `known` undefined leaves the keys to the caller.
	 * `undefined` when it is absent or not a table.
	 */
	table(
		value: unknown,
		path: string,
		known: readonly string[] | undefined,
	): Table | undefined {
		if (value === undefined) return undefined;
		if (!isTable(value)) {
			this.add(path, `must be a table, not ${describe(value)}`);
			return undefined;
		}
		if (known === undefined) return value;
		for (const key of Object.keys(value)) {
			if (known.includes(key)) continue;
			this.unknown(keyPath(path, key), key, known);
		}
		return value;
	}

	/** Refuses `key` at `path`, as a relay option or with the closest known key. */
	unknown(path: string, key: string, known: readonly string[]): void {
		if (RELAY_KEYS.has(key)) {
			this.add(path, 'not an option: bumail never relays without AUTH');
			return;
		}
		const close = didYouMean(key, known);
		this.add(
			path,
			close === undefined
				? 'unknown key'
				: `unknown key; did you mean "${close}"?`,
		);
	}

	string(
		table: Table | undefined,
		key: string,
		path: string,
	): string | undefined {
		const value = table?.[key];
		if (value === undefined) return undefined;
		if (typeof value !== 'string') {
			this.add(keyPath(path, key), `must be a string, not ${describe(value)}`);
			return undefined;
		}
		return value;
	}

	boolean(
		table: Table | undefined,
		key: string,
		path: string,
	): boolean | undefined {
		const value = table?.[key];
		if (value === undefined) return undefined;
		if (typeof value !== 'boolean') {
			this.add(
				keyPath(path, key),
				`must be true or false, not ${describe(value)}`,
			);
			return undefined;
		}
		return value;
	}

	integer(
		table: Table | undefined,
		key: string,
		path: string,
		min: number,
		max: number,
	): number | undefined {
		const value = table?.[key];
		if (value === undefined) return undefined;
		if (
			typeof value !== 'number' ||
			!Number.isInteger(value) ||
			value < min ||
			value > max
		) {
			this.add(keyPath(path, key), `must be an integer from ${min} to ${max}`);
			return undefined;
		}
		return value;
	}

	/** One of `choices`; the value itself is never repeated, only the choices. */
	oneOf<const T extends string>(
		table: Table | undefined,
		key: string,
		path: string,
		choices: readonly T[],
	): T | undefined {
		const value = this.string(table, key, path);
		if (value === undefined) return undefined;
		if (!(choices as readonly string[]).includes(value)) {
			this.add(keyPath(path, key), `must be ${choicesOf(choices)}`);
			return undefined;
		}
		return value as T;
	}
}

/** `"a"`, `"a" or "b"`, `"a", "b" or "c"`. */
export function choicesOf(choices: readonly string[]): string {
	const quoted = choices.map((choice) => `"${choice}"`);
	const last = quoted.pop() ?? '';
	return quoted.length === 0 ? last : `${quoted.join(', ')} or ${last}`;
}
