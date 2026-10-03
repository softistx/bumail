import { DnsError } from '../errors';
import { normalizeAddress, normalizeName } from '../name';
import type { RecordType, Resolver } from '../types';
import {
	type Answers,
	cached,
	type Entries,
	emptyEntries,
	remember,
	withTtlLeft,
} from './entries';

/** What a `cachedResolver` is built with. */
export interface CacheOptions {
	/** Answers kept at most; the least recently used goes first. 1000 by default. */
	readonly maxEntries?: number;
	/**
	 * Seconds any answer is kept at most, whatever its TTL — a `NOT_FOUND`
	 * kept for `negativeTtl` included. 86400 (a day) by default; 0 keeps
	 * nothing.
	 */
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

type Pending = {
	[K in RecordType]: Map<string, Promise<readonly Answers[K][]>>;
};

/**
 * Asks the resolver underneath and keeps what it answers: records for
 * their lowest TTL, capped at `maxTtl`; a `NOT_FOUND` for `negativeTtl`,
 * capped too; never a `TEMPORARY` or a `TIMEOUT`. An empty answer, which
 * breaks the `Resolver` contract, is a `NOT_FOUND`.
 */
async function ask<K extends RecordType>(
	entries: Entries,
	limits: { readonly maxTtl: number; readonly negativeTtl: number },
	type: K,
	name: string,
	query: () => Promise<readonly Answers[K][]>,
): Promise<readonly Answers[K][]> {
	try {
		const records = await query();
		if (records.length === 0) {
			throw new DnsError(
				'NOT_FOUND',
				`No ${type.toUpperCase()} ${name} record (the resolver underneath answered nothing)`,
			);
		}
		const ttl = Math.min(limits.maxTtl, ...records.map((record) => record.ttl));
		if (ttl > 0)
			remember(entries, type, name, {
				expires: entries.now() + ttl * 1000,
				records,
			});
		return records;
	} catch (error) {
		const ttl = Math.min(limits.negativeTtl, limits.maxTtl);
		if (error instanceof DnsError && error.code === 'NOT_FOUND' && ttl > 0)
			remember(entries, type, name, {
				expires: entries.now() + ttl * 1000,
				error,
			});
		throw error;
	}
}

/**
 * A `Resolver` that keeps another's answers for as long as their TTL says
 * (the lowest of the records', capped at `maxTtl`), keeps `NOT_FOUND` for
 * `negativeTtl`, and never keeps `TEMPORARY` or `TIMEOUT`: the next query
 * asks again. The records it returns carry the TTL they have left. Two
 * identical queries at once share one query to the resolver underneath,
 * its answer or its error. Memory is bounded by `maxEntries`.
 */
export function cachedResolver(
	inner: Resolver,
	options: CacheOptions = {},
): Resolver {
	const maxEntries = checkCount('maxEntries', options.maxEntries, 1000, 1);
	const limits = {
		maxTtl: checkCount('maxTtl', options.maxTtl, 86_400, 0),
		negativeTtl: checkCount('negativeTtl', options.negativeTtl, 300, 0),
	};
	const entries = emptyEntries(maxEntries, options.now ?? Date.now);
	const pending: Pending = {
		mx: new Map(),
		txt: new Map(),
		a: new Map(),
		aaaa: new Map(),
		ptr: new Map(),
	};

	async function lookup<K extends RecordType>(
		type: K,
		name: string,
		query: () => Promise<readonly Answers[K][]>,
	): Promise<readonly Answers[K][]> {
		const entry = cached(entries, type, name);
		if (entry?.error !== undefined) throw entry.error;
		if (entry?.records !== undefined) {
			const left = Math.ceil((entry.expires - entries.now()) / 1000);
			return withTtlLeft(entry.records, Math.max(0, left));
		}
		const shared: Map<string, Promise<readonly Answers[K][]>> = pending[type];
		let running = shared.get(name);
		if (running === undefined) {
			running = ask(entries, limits, type, name, query).finally(() =>
				shared.delete(name),
			);
			shared.set(name, running);
		}
		return withTtlLeft(await running, Number.POSITIVE_INFINITY);
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
