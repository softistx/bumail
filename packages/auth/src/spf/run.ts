import { DnsError, type Resolver } from '@bumail/dns';
import { beforeDeadline } from '../deadline';
import type { Ip } from './ip';
import type { SpfResultWord } from './result';

/** At most this many terms that query the DNS per check (§4.6.4). */
export const MAX_LOOKUPS = 10;
/** At most this many void lookups per check (§4.6.4). */
export const MAX_VOID_LOOKUPS = 2;
/** At most this many MX names per `mx`, and PTR names per `ptr` (§4.6.4). */
export const MAX_NAMES = 10;

/** One check's inputs, budget and counters, shared by every nested `include` and `redirect`. */
export interface Run {
	readonly resolver: Resolver;
	readonly ip: Ip;
	/** `<sender>`: `local@domain`, `postmaster@helo` when MAIL FROM is null. */
	readonly sender: string;
	readonly local: string;
	readonly senderDomain: string;
	readonly helo: string;
	readonly receiver: string;
	/** Seconds since the epoch, for `%{t}`. */
	readonly now: number;
	/** When the check gives up, in `performance.now()` milliseconds. */
	readonly deadline: number;
	readonly timeout: number;
	lookups: number;
	voids: number;
	/** The validated names of `ip`, looked up once (§5.5). */
	reverse?: Promise<Reverse>;
	/** Macro values already split, so each is split once per check (see `expand`). */
	splits?: Map<string, readonly string[] | undefined>;
}

/** The PTR answer for `ip`, its names validated; `void` when it had none. */
export type Reverse = { readonly void: boolean; readonly names: string[] };

/**
 * What ends a check before its last term: a `temperror` or a `permerror`.
 * It is caught where the check began and becomes the result; nothing
 * outside `checkSpf` sees it.
 */
export class Halt {
	constructor(
		readonly result: Extract<SpfResultWord, 'temperror' | 'permerror'>,
		readonly reason: string,
		/** The deadline passed: nothing that ignores DNS errors may ignore this one. */
		readonly late = false,
	) {}
}

/** Counts one term that queries the DNS, or halts past the limit. */
export function countLookup(run: Run): void {
	run.lookups++;
	if (run.lookups > MAX_LOOKUPS) {
		throw new Halt(
			'permerror',
			`more than ${MAX_LOOKUPS} DNS-querying terms (include, a, mx, ptr, exists, redirect)`,
		);
	}
}

/** Counts one void lookup, or halts past the limit. */
export function countVoid(run: Run): void {
	run.voids++;
	if (run.voids > MAX_VOID_LOOKUPS) {
		throw new Halt(
			'permerror',
			`more than ${MAX_VOID_LOOKUPS} void lookups (no such name, or no record)`,
		);
	}
}

function late(run: Run): Halt {
	return new Halt(
		'temperror',
		`the check took longer than its timeout (${run.timeout} ms)`,
		true,
	);
}

/** `promise`, unless the deadline comes first. */
function inTime<T>(run: Run, promise: Promise<T>): Promise<T> {
	return beforeDeadline(promise, run.deadline, () => late(run));
}

export type Query = 'txt' | 'a' | 'aaaa' | 'mx' | 'ptr';

/** What `lookUp` gives for a name the resolver refused before any query: no records, and no lookup either. */
const UNASKED: readonly never[] = Object.freeze([]);

/**
 * Whether `records` is a void lookup (§4.6.4): a query sent that found no
 * such name, or no record. A name refused before any query is not one.
 */
export function isVoid(records: readonly unknown[]): boolean {
	return records.length === 0 && records !== UNASKED;
}

type Answer<Q extends Query> = Awaited<ReturnType<Resolver[Q]>>;

/**
 * The records, or an empty array when there are none (`NOT_FOUND`, or a
 * name the resolver refuses to look up, which it cannot find either;
 * `isVoid` tells the two apart). A DNS failure halts with `temperror`
 * (§2.6.6), as does the deadline.
 */
export async function lookUp<Q extends Query>(
	run: Run,
	type: Q,
	name: string,
): Promise<Answer<Q>> {
	try {
		const query = run.resolver[type](name) as Promise<Answer<Q>>;
		return await inTime(run, query);
	} catch (error) {
		if (error instanceof Halt) throw error;
		if (error instanceof DnsError) {
			if (error.code === 'NOT_FOUND') return [] as unknown as Answer<Q>;
			if (error.code === 'INVALID_NAME') return UNASKED as Answer<Q>;
			throw new Halt(
				'temperror',
				`DNS lookup failed: ${error.code} for ${type.toUpperCase()} ${name}`,
			);
		}
		throw new Halt(
			'temperror',
			`DNS lookup failed: ${String(error)} for ${type.toUpperCase()} ${name}`,
		);
	}
}

/** `lookUp`, its DNS failures read as no records; only the deadline still halts. */
export async function lookUpLeniently<Q extends Query>(
	run: Run,
	type: Q,
	name: string,
): Promise<Answer<Q>> {
	try {
		return await lookUp(run, type, name);
	} catch (error) {
		if (error instanceof Halt && error.late) throw error;
		return [] as unknown as Answer<Q>;
	}
}
