import { invalid } from '../../errors';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
/** The longest delay a timer takes: past it, Bun fires after 1 ms. */
export const MAX_TIMER = 2_147_483_647;

/** A number in `[min, max]`, integer when asked, or its default. */
export function numberOf(
	name: string,
	value: unknown,
	fallback: number,
	min: number,
	max = Number.MAX_SAFE_INTEGER,
	integer = true,
): number {
	if (value === undefined) return fallback;
	const ok =
		typeof value === 'number' &&
		(integer ? Number.isInteger(value) : Number.isFinite(value)) &&
		value >= min &&
		value <= max;
	if (!ok) {
		const kind = integer ? 'an integer' : 'a number';
		const range =
			max === Number.MAX_SAFE_INTEGER
				? `of at least ${min}`
				: `from ${min} to ${max}`;
		throw invalid(`${name} must be ${kind} ${range}, not ${value}`);
	}
	return value as number;
}
