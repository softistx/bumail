import { StoreError } from '../errors';
import type { FlagChange } from './types';

/** The system flags of RFC 9051 §2.3.2 a store keeps; `\Recent` is gone in IMAP4rev2. */
export const SYSTEM_FLAGS = [
	'\\Answered',
	'\\Deleted',
	'\\Draft',
	'\\Flagged',
	'\\Seen',
] as const;

/** An IMAP flag-keyword (RFC 9051 §9, `atom`), which JMAP keywords are too. */
const KEYWORD = /^[^\s(){%*"\\\]]+$/;

/** Whether text holds a control character (U+0000 to U+001F, U+007F). */
export function hasControl(text: string): boolean {
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** A flag as stored: a system flag in its canonical case, a keyword as given. */
export function normalizeFlag(flag: string): string {
	if (flag.startsWith('\\')) {
		const system = SYSTEM_FLAGS.find(
			(name) => name.toLowerCase() === flag.toLowerCase(),
		);
		if (system) return system;
	} else if (KEYWORD.test(flag) && !hasControl(flag)) {
		return flag;
	}
	throw new StoreError('INVALID', `"${flag}" is not a flag a store keeps`);
}

/** Flags, normalised, without duplicates, sorted. */
export function normalizeFlags(flags: readonly string[]): string[] {
	return [...new Set(flags.map(normalizeFlag))].sort();
}

/** The flags after a change; `set` first, then `add`, then `remove`. */
export function applyFlagChange(
	current: readonly string[],
	change: FlagChange,
): string[] {
	const flags = new Set(
		change.set === undefined ? current : normalizeFlags(change.set),
	);
	for (const flag of normalizeFlags(change.add ?? [])) flags.add(flag);
	for (const flag of normalizeFlags(change.remove ?? [])) flags.delete(flag);
	return [...flags].sort();
}

export function sameFlags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((flag, i) => flag === b[i]);
}
