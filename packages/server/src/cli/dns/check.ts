import { isIP } from 'node:net';
import { sameDkimRecord, sameDmarcRecord, sameSpfRecord } from '@bumail/auth';
import { DnsError, normalizeName, type Resolver } from '@bumail/dns';
import type { Plan, Wanted } from './plan';

/**
 * What the DNS answered for one record:
 * - `ok`: the record is there.
 * - `missing`: there is no such record.
 * - `differs`: there is one of its kind, but not this one; `found` has what is there.
 * - `duplicate`: there are several SPF or several DMARC records at the name, which every receiver
 *   answers with `permerror`, whichever is right; `found` has them.
 * - `unavailable`: the DNS gave no answer (`detail` says why), so nothing is known.
 * - `unchecked`: not looked up, since `@bumail/dns` cannot (SRV, CAA).
 */
export type Status =
	| 'ok'
	| 'missing'
	| 'differs'
	| 'duplicate'
	| 'unavailable'
	| 'unchecked';

export interface Checked {
	readonly wanted: Wanted;
	readonly status: Status;
	/** What the DNS holds at the name, as the record would be written. */
	readonly found: readonly string[];
	readonly detail?: string;
}

/** An IPv6 address in the one spelling the DNS and the operator can differ on. */
function canonical(address: string): string {
	return isIP(address) === 6
		? new URL(`http://[${address}]`).hostname.slice(1, -1)
		: address;
}

type TextKind = 'spf' | 'dmarc' | 'dkim';

const KINDS: Readonly<Record<string, TextKind>> = {
	spf1: 'spf',
	dmarc1: 'dmarc',
	dkim1: 'dkim',
};

/** What a TXT record is a record of, by its `v=` tag, any case and spacing; `undefined` for any other text. */
function kindOf(text: string): TextKind | undefined {
	const version = /^\s*v\s*=\s*([a-z0-9]+)\s*(?:[; ]|$)/i.exec(text)?.[1];
	return KINDS[(version ?? '').toLowerCase()];
}

const SAME: Readonly<Record<TextKind, (a: string, b: string) => boolean>> = {
	spf: sameSpfRecord,
	dmarc: sameDmarcRecord,
	dkim: sameDkimRecord,
};

/** What the DNS holds at a record's name, and whether the wanted record is among it. */
async function lookUp(
	resolver: Resolver,
	{ record }: Wanted,
): Promise<{ status: Status; found: string[] }> {
	if (record.type === 'MX') {
		const answer = await resolver.mx(record.name);
		const found = answer.map((r) => `${r.priority} ${r.exchange}`);
		const want = `${record.priority} ${normalizeName(record.value)}`;
		return { status: found.includes(want) ? 'ok' : 'differs', found };
	}
	if (record.type === 'A' || record.type === 'AAAA') {
		const answer =
			record.type === 'A'
				? await resolver.a(record.name)
				: await resolver.aaaa(record.name);
		const found = answer.map((r) => canonical(r.address));
		return {
			status: found.includes(canonical(record.value)) ? 'ok' : 'differs',
			found,
		};
	}
	const kind = kindOf(record.value) as TextKind;
	const found = (await resolver.txt(record.name))
		.map((r) => r.text.trim())
		.filter((text) => kindOf(text) === kind);
	if (found.length === 0) return { status: 'missing', found };
	if (found.length > 1 && kind !== 'dkim')
		return { status: 'duplicate', found };
	const there = found.some((text) => SAME[kind](text, record.value));
	return { status: there ? 'ok' : 'differs', found };
}

async function checkOne(resolver: Resolver, wanted: Wanted): Promise<Checked> {
	const { type } = wanted.record;
	if (type !== 'MX' && type !== 'A' && type !== 'AAAA' && type !== 'TXT') {
		return { wanted, status: 'unchecked', found: [] };
	}
	try {
		return { wanted, ...(await lookUp(resolver, wanted)) };
	} catch (error) {
		if (!(error instanceof DnsError)) throw error;
		return error.code === 'NOT_FOUND'
			? { wanted, status: 'missing', found: [] }
			: {
					wanted,
					status: 'unavailable',
					found: [],
					detail: error.message,
				};
	}
}

/** Without `--ip`, the host name only has to resolve, to an A or an AAAA record. */
async function resolves(
	resolver: Resolver,
	hostname: string,
): Promise<Checked> {
	const wanted: Wanted = {
		scope: hostname,
		purpose: 'host',
		optional: false,
		record: { name: hostname, type: 'A', value: '(any address)' },
	};
	const attempts = [resolver.a(hostname), resolver.aaaa(hostname)];
	const answers = await Promise.allSettled(attempts);
	const found = answers.flatMap((answer) =>
		answer.status === 'fulfilled'
			? answer.value.map((r) => canonical(r.address))
			: [],
	);
	if (found.length > 0) return { wanted, status: 'ok', found };
	const down = answers.find(
		(a) =>
			a.status === 'rejected' &&
			(!(a.reason instanceof DnsError) || a.reason.code !== 'NOT_FOUND'),
	);
	if (down === undefined) return { wanted, status: 'missing', found: [] };
	return {
		wanted,
		status: 'unavailable',
		found: [],
		detail: String((down as PromiseRejectedResult).reason?.message ?? down),
	};
}

/** The reverse DNS of an address given with `--ip` or `--ip6` should name the host. */
async function reverse(
	resolver: Resolver,
	address: string,
	hostname: string,
): Promise<Checked> {
	const wanted: Wanted = {
		scope: hostname,
		purpose: 'host',
		optional: false,
		record: { name: address, type: 'PTR', value: hostname },
	};
	try {
		const found = (await resolver.ptr(address)).map((r) => r.name);
		return {
			wanted,
			status: found.includes(normalizeName(hostname)) ? 'ok' : 'differs',
			found,
		};
	} catch (error) {
		if (!(error instanceof DnsError)) throw error;
		return error.code === 'NOT_FOUND'
			? { wanted, status: 'missing', found: [] }
			: { wanted, status: 'unavailable', found: [], detail: error.message };
	}
}

/** Every record the plan wants, looked up through `resolver`: optional ones are left out. */
export async function check(
	plan: Plan,
	resolver: Resolver,
): Promise<readonly Checked[]> {
	const wanted = plan.records.filter((record) => !record.optional);
	const [results, ptrs, host] = await Promise.all([
		Promise.all(wanted.map((w) => checkOne(resolver, w))),
		Promise.all(
			plan.addresses.map((address) =>
				reverse(resolver, address, plan.hostname),
			),
		),
		plan.hasIp
			? Promise.resolve([])
			: resolves(resolver, plan.hostname).then((c) => [c]),
	]);
	const own = (c: Checked) => c.wanted.scope === plan.hostname;
	return [
		...host,
		...results.filter(own),
		...ptrs,
		...results.filter((c) => !own(c)),
	];
}

/** `ok`; `unavailable` when the only trouble is a DNS that did not answer; `wrong` when a record is missing, differs or is doubled. */
export function outcome(
	checks: readonly Checked[],
): 'ok' | 'wrong' | 'unavailable' {
	const has = (...statuses: Status[]) =>
		checks.some((c) => statuses.includes(c.status));
	if (has('missing', 'differs', 'duplicate')) return 'wrong';
	return has('unavailable') ? 'unavailable' : 'ok';
}
