import { DnsError } from './errors';
import { normalizeAddress, normalizeName } from './name';
import type { RecordType, Resolver } from './types';

/** What a `cachedResolver` is built with. */
export interface CacheOptions {
	/** Answers kept at most; the least recently used goes first. 1000 by default. */
	readonly maxEntries?: number;
	/** Seconds a positive answer is kept at most, whatever its TTL. 86400 (a day) by default. */
	readonly maxTtl?: number;
	/**
	 * Seconds a `NOT_FOUND` is kept (RFC 2308's negative caching). The SOA
	 * minimum that would bound it is not available here, so it is this
	 * fixed time. 300 by default; 0 keeps none.
	 */
	readonly negativeTtl?: number;
	/** The clock, in milliseconds: `Date.now` by default, a fake one in specs. */
	readonly now?: () => number;
}

type Entry = {
	readonly expires: number;
	readonly records?: readonly { ttl: number }[];
	readonly error?: DnsError;
};

function checkCount(
	name: string,
	value: number | undefined,
	fallback: number,
	least: number,
): number {
	const count = value ?? fallback;
	if (!Number.isInteger(count) || count < least) {
		throw new DnsError(
			'INVALID_OPTION',
			`cachedResolver(): ${name} must be an integer of at least ${least}, not ${String(value)}`,
		);
	}
	return count;
}

/**
 * A `Resolver` that keeps another's answers for as long as their TTL says
 * (the lowest of the records', capped at `maxTtl`), keeps `NOT_FOUND` for
 * `negativeTtl`, and never keeps `TEMPORARY` or `TIMEOUT`: the next query
 * asks again. The records it returns carry the TTL they have left. Two
 * identical queries at once share one query to the resolver underneath.
 * Memory is bounded by `maxEntries`.
 */
export function cachedResolver(
	inner: Resolver,
	options: CacheOptions = {},
): Resolver {
	const maxEntries = checkCount('maxEntries', options.maxEntries, 1000, 1);
	const maxTtl = checkCount('maxTtl', options.maxTtl, 86_400, 0);
	const negativeTtl = checkCount('negativeTtl', options.negativeTtl, 300, 0);
	const now = options.now ?? Date.now;
	const entries = new Map<string, Entry>();
	const pending = new Map<string, Promise<readonly { ttl: number }[]>>();

	function remember(key: string, entry: Entry): void {
		entries.delete(key);
		entries.set(key, entry);
		while (entries.size > maxEntries) {
			const oldest = entries.keys().next().value;
			if (oldest === undefined) break;
			entries.delete(oldest);
		}
	}

	function cached(key: string): Entry | undefined {
		const entry = entries.get(key);
		if (entry === undefined) return undefined;
		entries.delete(key);
		if (entry.expires <= now()) return undefined;
		entries.set(key, entry);
		return entry;
	}

	async function fetch(
		key: string,
		ask: () => Promise<readonly { ttl: number }[]>,
	) {
		try {
			const records = await ask();
			const ttl = Math.min(maxTtl, ...records.map((record) => record.ttl));
			if (ttl > 0) remember(key, { expires: now() + ttl * 1000, records });
			return records;
		} catch (error) {
			if (
				error instanceof DnsError &&
				error.code === 'NOT_FOUND' &&
				negativeTtl > 0
			) {
				remember(key, { expires: now() + negativeTtl * 1000, error });
			}
			throw error;
		}
	}

	async function lookup<T extends { ttl: number }>(
		type: RecordType,
		name: string,
		ask: () => Promise<readonly T[]>,
	): Promise<readonly T[]> {
		const key = `${type} ${name}`;
		const entry = cached(key);
		if (entry?.error !== undefined) throw entry.error;
		if (entry?.records !== undefined) {
			const left = Math.max(0, Math.ceil((entry.expires - now()) / 1000));
			return entry.records.map((record) => ({
				...(record as T),
				ttl: Math.min(record.ttl, left),
			}));
		}
		let running = pending.get(key);
		if (running === undefined) {
			running = fetch(key, ask).finally(() => pending.delete(key));
			pending.set(key, running);
		}
		return (await running).map((record) => ({ ...(record as T) }));
	}

	return {
		mx: async (name) => {
			const domain = normalizeName(name);
			return lookup('mx', domain, () => inner.mx(domain));
		},
		txt: async (name) => {
			const domain = normalizeName(name);
			return lookup('txt', domain, () => inner.txt(domain));
		},
		a: async (name) => {
			const domain = normalizeName(name);
			return lookup('a', domain, () => inner.a(domain));
		},
		aaaa: async (name) => {
			const domain = normalizeName(name);
			return lookup('aaaa', domain, () => inner.aaaa(domain));
		},
		ptr: async (address) => {
			const ip = normalizeAddress(address);
			return lookup('ptr', ip, () => inner.ptr(ip));
		},
	};
}
