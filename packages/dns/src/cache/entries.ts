import type { DnsError } from '../errors';
import type {
	AddressRecord,
	MxRecord,
	PtrRecord,
	RecordType,
	TxtRecord,
} from '../types';

/** The record each type answers with. */
export interface Answers {
	readonly mx: MxRecord;
	readonly txt: TxtRecord;
	readonly a: AddressRecord;
	readonly aaaa: AddressRecord;
	readonly ptr: PtrRecord;
}

/** One kept answer: the records, or the `NOT_FOUND` the resolver underneath gave. */
export interface Entry<T> {
	readonly expires: number;
	readonly records?: readonly T[];
	readonly error?: DnsError;
}

/**
 * What a cache keeps, as data: the answers by type and name, and every key
 * in the order it was last used, oldest first, which is what `maxEntries`
 * bounds.
 */
export interface Entries {
	readonly maxEntries: number;
	readonly now: () => number;
	readonly byType: {
		readonly [K in RecordType]: Map<string, Entry<Answers[K]>>;
	};
	readonly order: Map<
		string,
		{ readonly type: RecordType; readonly name: string }
	>;
}

export function emptyEntries(maxEntries: number, now: () => number): Entries {
	return {
		maxEntries,
		now,
		byType: {
			mx: new Map(),
			txt: new Map(),
			a: new Map(),
			aaaa: new Map(),
			ptr: new Map(),
		},
		order: new Map(),
	};
}

function touch(entries: Entries, type: RecordType, name: string): void {
	const key = `${type} ${name}`;
	entries.order.delete(key);
	entries.order.set(key, { type, name });
}

function forget(entries: Entries, type: RecordType, name: string): void {
	entries.order.delete(`${type} ${name}`);
	entries.byType[type].delete(name);
}

/** Keeps an entry, as the most recently used, and forgets the least recently used beyond `maxEntries`. */
export function remember<K extends RecordType>(
	entries: Entries,
	type: K,
	name: string,
	entry: Entry<Answers[K]>,
): void {
	entries.byType[type].set(name, entry);
	touch(entries, type, name);
	while (entries.order.size > entries.maxEntries) {
		const oldest = entries.order.values().next().value;
		if (oldest === undefined) break;
		forget(entries, oldest.type, oldest.name);
	}
}

/** The entry kept for a name, now the most recently used; `undefined` when there is none or it expired. */
export function cached<K extends RecordType>(
	entries: Entries,
	type: K,
	name: string,
): Entry<Answers[K]> | undefined {
	const entry = entries.byType[type].get(name);
	if (entry === undefined) return undefined;
	if (entry.expires <= entries.now()) {
		forget(entries, type, name);
		return undefined;
	}
	touch(entries, type, name);
	return entry;
}

/** Copies of the records, each TTL counted down to what is left of the entry's. */
export function withTtlLeft<T extends { readonly ttl: number }>(
	records: readonly T[],
	left: number,
): T[] {
	return records.map((record) => ({
		...record,
		ttl: Math.min(record.ttl, left),
	}));
}
