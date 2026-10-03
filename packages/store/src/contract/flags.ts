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

/**
 * A keyword: an IMAP `atom` (RFC 9051 §9) in printable ASCII, which is also
 * what a JMAP keyword may be (RFC 8621 §4.1.1), 255 characters at most.
 */
const KEYWORD = /^[!#$&'+,\-./0-9:;<=>?@A-Z[^_`a-z|}~]{1,255}$/;

/** Whether text holds a control character (U+0000 to U+001F, U+007F). */
export function hasControl(text: string): boolean {
	for (const char of text) {
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * A flag as stored: a system flag in its canonical case, a keyword as it
 * was written. IMAP and JMAP compare keywords without case (RFC 9051 §2.3.2),
 * so a store compares them by `flagKey`; it keeps a keyword's spelling
 * because a client looks for the one it set — `$Forwarded`, `$MDNSent`,
 * `NonJunk`.
 */
export function normalizeFlag(flag: string): string {
	if (typeof flag === 'string' && flag.startsWith('\\')) {
		const system = SYSTEM_FLAGS.find(
			(name) => name.toLowerCase() === flag.toLowerCase(),
		);
		if (system) return system;
	} else if (typeof flag === 'string' && KEYWORD.test(flag)) {
		return flag;
	}
	throw new StoreError('INVALID', `"${flag}" is not a flag a store keeps`);
}

/** What two flags that differ only by case share: the same flag. */
export function flagKey(flag: string): string {
	return flag.toLowerCase();
}

/** Flags in a stable order: by `flagKey`, each key once. */
function sortFlags(flags: Iterable<string>): string[] {
	return [...flags].sort((a, b) => {
		const x = flagKey(a);
		const y = flagKey(b);
		return x < y ? -1 : x > y ? 1 : 0;
	});
}

/** Flags, normalised, without duplicates — the first spelling of a keyword kept — sorted. */
export function normalizeFlags(flags: readonly string[]): string[] {
	if (!Array.isArray(flags)) {
		throw new StoreError('INVALID', 'Flags are an array of strings');
	}
	const byKey = new Map<string, string>();
	for (const flag of flags.map(normalizeFlag)) {
		const key = flagKey(flag);
		if (!byKey.has(key)) byKey.set(key, flag);
	}
	return sortFlags(byKey.values());
}

/** A change with its flags normalised, so applying it cannot throw. */
export function normalizeChange(change: FlagChange): FlagChange {
	if (typeof change !== 'object' || change === null) {
		throw new StoreError('INVALID', 'A flag change is an object');
	}
	return {
		...(change.set === undefined ? {} : { set: normalizeFlags(change.set) }),
		add: normalizeFlags(change.add ?? []),
		remove: normalizeFlags(change.remove ?? []),
	};
}

/**
 * The flags after a normalised change: `set` first, then `add`, then
 * `remove`, each compared without case. A keyword the message has keeps the
 * spelling it was stored with, so `$junk` added to `$Junk` changes nothing.
 */
export function applyFlagChange(
	current: readonly string[],
	change: FlagChange,
): string[] {
	const stored = new Map(current.map((flag) => [flagKey(flag), flag]));
	const flags = new Map<string, string>();
	const keep = (flag: string) => {
		const key = flagKey(flag);
		if (!flags.has(key)) flags.set(key, stored.get(key) ?? flag);
	};
	for (const flag of change.set ?? current) keep(flag);
	for (const flag of change.add ?? []) keep(flag);
	for (const flag of change.remove ?? []) flags.delete(flagKey(flag));
	return sortFlags(flags.values());
}

export function sameFlags(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((flag, i) => flag === b[i]);
}

/**
 * What a normalised flag change does to one message: `'modified'` when
 * `unchangedSince` refuses it (RFC 7162), its new flags when they differ,
 * `undefined` when they stay as they are.
 */
export function flagsAfter(
	message: { readonly flags: readonly string[]; readonly modseq: number },
	change: FlagChange,
	unchangedSince: number | undefined,
): 'modified' | string[] | undefined {
	if (unchangedSince !== undefined && message.modseq > unchangedSince) {
		return 'modified';
	}
	const flags = applyFlagChange(message.flags, change);
	return sameFlags(flags, message.flags) ? undefined : flags;
}
