import { isIP } from 'node:net';
import { DnsError, type DnsErrorCode } from './errors';
import { normalizeAddress, normalizeName, targetName } from './name';
import type {
	AddressRecord,
	MxRecord,
	PtrRecord,
	RecordType,
	Resolver,
	TxtRecord,
} from './types';

/** An error a fixture answers with, by its code; `NOT_FOUND` is what a missing record gives anyway. */
export type FixtureError = Exclude<
	DnsErrorCode,
	'INVALID_NAME' | 'INVALID_OPTION'
>;

/** The records at one name. A record type left out is `NOT_FOUND`; one set to an error code answers with it. */
export interface FixtureName {
	readonly mx?:
		| readonly (Omit<MxRecord, 'ttl'> & { ttl?: number })[]
		| FixtureError;
	/** A string is one record; an array of strings is one record of several character-strings. */
	readonly txt?:
		| readonly (string | readonly string[] | { text: string; ttl?: number })[]
		| FixtureError;
	readonly a?:
		| readonly (string | { address: string; ttl?: number })[]
		| FixtureError;
	readonly aaaa?:
		| readonly (string | { address: string; ttl?: number })[]
		| FixtureError;
	readonly ptr?:
		| readonly (string | { name: string; ttl?: number })[]
		| FixtureError;
	/** Every record type at this name answers with this error. */
	readonly error?: FixtureError;
}

/** What a fixture resolver answers from: names (PTR by address: `'192.0.2.1': { ptr: […] }`). */
export type FixtureRecords = Readonly<Record<string, FixtureName>>;

/** A fixture resolver, with the queries it was asked, for a spec to count (SPF's ten-lookup limit). */
export interface FixtureResolver extends Resolver {
	readonly queries: readonly {
		readonly type: RecordType;
		readonly name: string;
	}[];
}

/** The fixture's records at a normalised name, keys normalised too. */
function indexOf(records: FixtureRecords): Map<string, FixtureName> {
	const index = new Map<string, FixtureName>();
	for (const [key, value] of Object.entries(records)) {
		const name = isIP(key) === 0 ? normalizeName(key) : normalizeAddress(key);
		index.set(name, value);
	}
	return index;
}

/**
 * A `Resolver` that answers from a plain object, for specs: deterministic,
 * never on the network, and able to answer with any error a real DNS can.
 * Names are normalised as every resolver does, a TTL left out is 300, and
 * every query is recorded in `queries`.
 *
 * ```ts
 * const dns = fixtureResolver({
 *   'example.com': { mx: [{ exchange: 'mx.example.com', priority: 10 }], txt: ['v=spf1 -all'] },
 *   'mx.example.com': { a: ['192.0.2.25'] },
 *   'down.example': { error: 'TEMPORARY' },
 * });
 * ```
 */
export function fixtureResolver(records: FixtureRecords): FixtureResolver {
	const index = indexOf(records);
	const queries: { type: RecordType; name: string }[] = [];
	async function answer<T, R>(
		type: RecordType,
		name: string,
		pick: (at: FixtureName) => readonly T[] | FixtureError | undefined,
		read: (entry: T) => R,
	): Promise<R[]> {
		queries.push({ type, name });
		const at = index.get(name);
		const set = at === undefined ? undefined : (at.error ?? pick(at));
		const label = `${type.toUpperCase()} ${name}`;
		if (typeof set === 'string') {
			throw new DnsError(set, `The fixture answers ${label} with ${set}`);
		}
		if (set === undefined || set.length === 0) {
			throw new DnsError(
				'NOT_FOUND',
				`No ${label} record (the fixture has none)`,
			);
		}
		return set.map(read);
	}
	return {
		queries,
		async mx(name) {
			const domain = normalizeName(name);
			const out = await answer(
				'mx',
				domain,
				(at) => at.mx,
				(r): MxRecord => ({
					exchange: targetName(r.exchange),
					priority: r.priority,
					ttl: r.ttl ?? 300,
				}),
			);
			return out.sort((x, y) => x.priority - y.priority);
		},
		async txt(name) {
			return answer(
				'txt',
				normalizeName(name),
				(at) => at.txt,
				(r): TxtRecord =>
					typeof r === 'string'
						? { text: r, ttl: 300 }
						: 'text' in r
							? { text: r.text, ttl: r.ttl ?? 300 }
							: { text: r.join(''), ttl: 300 },
			);
		},
		async a(name) {
			return answer('a', normalizeName(name), (at) => at.a, addressOf);
		},
		async aaaa(name) {
			return answer('aaaa', normalizeName(name), (at) => at.aaaa, addressOf);
		},
		async ptr(address) {
			return answer(
				'ptr',
				normalizeAddress(address),
				(at) => at.ptr,
				(r): PtrRecord =>
					typeof r === 'string'
						? { name: targetName(r), ttl: 300 }
						: { name: targetName(r.name), ttl: r.ttl ?? 300 },
			);
		},
	};
}

function addressOf(
	record: string | { address: string; ttl?: number },
): AddressRecord {
	return typeof record === 'string'
		? { address: record, ttl: 300 }
		: { address: record.address, ttl: record.ttl ?? 300 };
}
