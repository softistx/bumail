import { isIP } from 'node:net';
import { DnsError, normalizeName, type Resolver } from '@bumail/dns';
import type { Plan, Wanted } from './plan';

/**
 * What the DNS answered for one record:
 * - `ok`: the record is there.
 * - `missing`: there is no such record.
 * - `differs`: there is one of its kind, but not this one; `found` has what is there.
 * - `unavailable`: the DNS gave no answer (`detail` says why), so nothing is known.
 * - `unchecked`: not looked up, since `@bumail/dns` cannot (SRV, CAA).
 */
export type Status = 'ok' | 'missing' | 'differs' | 'unavailable' | 'unchecked';

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

/** The tag a TXT record starts with (`v=spf1`, `v=DMARC1`, `v=DKIM1`), which says what it is a record of. */
function kindOf(text: string): string {
	return text.split(/[; ]/, 1)[0] ?? '';
}

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
	const found = (await resolver.txt(record.name))
		.map((r) => r.text.trim())
		.filter((text) => kindOf(text) === kindOf(record.value));
	if (found.includes(record.value)) return { status: 'ok', found };
	return { status: found.length === 0 ? 'missing' : 'differs', found };
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

/** Every record the plan wants, looked up through `resolver`: optional ones are left out. */
export async function check(
	plan: Plan,
	resolver: Resolver,
): Promise<readonly Checked[]> {
	const wanted = plan.records.filter((record) => !record.optional);
	const results = await Promise.all(wanted.map((w) => checkOne(resolver, w)));
	return plan.hasIp
		? results
		: [await resolves(resolver, plan.hostname), ...results];
}

/** Whether every record checked is there (an unchecked one counts as there). */
export function allThere(checks: readonly Checked[]): boolean {
	return checks.every((c) => c.status === 'ok' || c.status === 'unchecked');
}

const WIDTH = 72;

function clip(text: string): string {
	return text.length > WIDTH ? `${text.slice(0, WIDTH)}…` : text;
}

/** `value` of a record as the report shows it. */
function shown({ record }: Wanted): string {
	return record.type === 'MX'
		? `${record.priority} ${record.value}`
		: record.value;
}

/** The report of `bumail dns --check`: a line per record, then what it comes to. */
export function renderChecks(checks: readonly Checked[]): string {
	const out: string[] = [];
	let scope = '';
	for (const c of checks) {
		if (c.wanted.scope !== scope) {
			scope = c.wanted.scope;
			out.push(scope);
		}
		const { record } = c.wanted;
		out.push(
			`  ${c.status.padEnd(11)}${record.type.padEnd(5)}${record.name}  ${clip(shown(c.wanted))}`,
		);
		if (c.status === 'differs') {
			for (const text of c.found)
				out.push(`${' '.repeat(18)}found  ${clip(text)}`);
		}
		if (c.detail !== undefined) out.push(`${' '.repeat(18)}${clip(c.detail)}`);
	}
	const count = (status: Status) =>
		checks.filter((c) => c.status === status).length;
	const problems = (['missing', 'differs', 'unavailable'] as const)
		.filter((status) => count(status) > 0)
		.map((status) => `${count(status)} ${status}`);
	out.push(
		'',
		problems.length === 0
			? `all ${checks.length - count('unchecked')} records checked are in the DNS${count('unchecked') > 0 ? `; ${count('unchecked')} (SRV) cannot be looked up here` : ''}`
			: `${problems.join(', ')}: bumail dns prints what to publish`,
	);
	return `${out.join('\n')}\n`;
}
