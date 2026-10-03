import type { FixtureName, FixtureRecords } from '@bumail/dns';
import { normalizeName } from '@bumail/dns';

/**
 * The OpenSPF RFC 7208 test suite (release 2014.04), as pyspf ships it in
 * `test/rfc7208-tests.yml`, read with `Bun.YAML` and turned into
 * `fixtureResolver` zones. The YAML is committed unchanged beside this
 * file; its licence is in `rfc7208-tests.LICENSE`.
 */

export interface SuiteCase {
	readonly name: string;
	readonly spec: string;
	readonly host: string;
	readonly mailfrom: string;
	readonly helo: string;
	/** One result, or several the suite accepts. */
	readonly results: readonly string[];
	/** The explanation expected, `undefined` when the suite does not check it, `'DEFAULT'` for none. */
	readonly explanation?: string;
}

export interface SuiteScenario {
	readonly description: string;
	readonly zone: FixtureRecords;
	readonly cases: readonly SuiteCase[];
}

type Entry = string | Readonly<Record<string, unknown>>;

/** A zone name as the fixture keys it: an address for a PTR name, `undefined` for a name no resolver would look up. */
function keyOf(name: string): string | undefined {
	const lower = name.toLowerCase();
	if (lower.endsWith('.in-addr.arpa')) {
		return lower.split('.').slice(0, 4).reverse().join('.');
	}
	if (lower.endsWith('.ip6.arpa')) {
		const nibbles = lower.split('.').slice(0, 32).reverse().join('');
		return (nibbles.match(/.{4}/g) ?? []).join(':');
	}
	try {
		return normalizeName(name);
	} catch {
		return undefined;
	}
}

interface Collected {
	timeout: boolean;
	cname?: string;
	txt?: (string | string[])[];
	spf: (string | string[])[];
	a: string[];
	aaaa: string[];
	mx: { exchange: string; priority: number }[];
	ptr: string[];
}

function textOf(value: unknown): string | string[] {
	return Array.isArray(value) ? value.map(String) : String(value);
}

function collect(entries: readonly Entry[]): Collected {
	const at: Collected = {
		timeout: false,
		spf: [],
		a: [],
		aaaa: [],
		mx: [],
		ptr: [],
	};
	for (const entry of entries) {
		if (entry === 'TIMEOUT') {
			at.timeout = true;
			continue;
		}
		for (const [type, value] of Object.entries(entry as object)) {
			if (type === 'TXT') {
				at.txt ??= [];
				if (value !== 'NONE') at.txt.push(textOf(value));
			} else if (type === 'SPF') at.spf.push(textOf(value));
			else if (type === 'A') at.a.push(String(value));
			else if (type === 'AAAA') at.aaaa.push(String(value));
			else if (type === 'PTR') at.ptr.push(String(value));
			else if (type === 'CNAME') at.cname = String(value).toLowerCase();
			else if (type === 'MX') {
				const [priority, exchange] = value as [number, string];
				at.mx.push({ priority, exchange: exchange === '' ? '.' : exchange });
			}
		}
	}
	return at;
}

/**
 * The suite driver's rules: a name's SPF-type records stand for its TXT
 * records when it lists no TXT (RFC 7208 dropped type SPF, so only TXT
 * is queried), `TXT: NONE` means none, and `TIMEOUT` times out every type
 * the name has no record of.
 */
function fixtureOf(at: Collected): FixtureName {
	const txt = at.txt ?? at.spf;
	const set = <T>(records: readonly T[]) =>
		records.length > 0
			? records
			: at.timeout
				? ('TIMEOUT' as const)
				: undefined;
	const out: Record<string, unknown> = {};
	for (const [type, records] of [
		['txt', txt],
		['a', at.a],
		['aaaa', at.aaaa],
		['mx', at.mx],
		['ptr', at.ptr],
	] as const) {
		const value = set<unknown>(records);
		if (value !== undefined) out[type] = value;
	}
	return out as FixtureName;
}

/** A zone: CNAMEs replaced by their target's records (a loop is a server failure), PTR names by addresses. */
export function zoneOf(
	data: Readonly<Record<string, readonly Entry[]>>,
): FixtureRecords {
	const names = new Map(
		Object.entries(data).map(([name, entries]) => [
			name.toLowerCase(),
			collect(entries),
		]),
	);
	const zone: Record<string, FixtureName> = {};
	for (const [name, at] of names) {
		const key = keyOf(name);
		if (key === undefined) continue;
		let target: Collected | undefined = at;
		const seen = new Set<string>([name]);
		while (target?.cname !== undefined && !seen.has(target.cname)) {
			seen.add(target.cname);
			target = names.get(target.cname.replace(/\.$/, ''));
		}
		zone[key] =
			target === undefined
				? {}
				: target.cname !== undefined
					? { error: 'TEMPORARY' }
					: fixtureOf(target);
	}
	return zone;
}

type Raw = Readonly<Record<string, unknown>>;

/** Every scenario of the suite, parsed from the YAML beside this file. */
export async function loadSuite(): Promise<SuiteScenario[]> {
	const text = await Bun.file(
		new URL('./rfc7208-tests.yml', import.meta.url),
	).text();
	const documents = Bun.YAML.parse(text) as Raw[];
	return documents.map((doc) => ({
		description: String(doc['description']),
		zone: zoneOf(doc['zonedata'] as Record<string, Entry[]>),
		cases: Object.entries(doc['tests'] as Record<string, Raw>).map(
			([name, t]) => ({
				name,
				spec: String(t['spec']),
				host: String(t['host']),
				mailfrom: String(t['mailfrom'] ?? ''),
				helo: String(t['helo']),
				results: ([] as unknown[]).concat(t['result']).map(String),
				...(t['explanation'] === undefined
					? {}
					: { explanation: String(t['explanation']) }),
			}),
		),
	}));
}
