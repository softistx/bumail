import { formatZone } from '@bumail/dns';
import { type Checked, outcome, type Status } from './check';
import type { Note, Plan, Wanted } from './plan';

/** A record as a line of the zone file, commented out when it is optional. */
function line(wanted: Wanted): string {
	const text = formatZone([wanted.record]).trimEnd();
	return wanted.optional ? `; optional: ${text}` : text;
}

/** The sections: the host name first, then each domain, each with its records and its notes. */
function sections(plan: Plan): [string, Wanted[], Note[]][] {
	return [plan.hostname, ...plan.domains].map((scope) => [
		scope,
		plan.records.filter((wanted) => wanted.scope === scope),
		plan.notes.filter((note) => note.scope === scope),
	]);
}

/** The records as a zone file a DNS host imports as is: what it cannot know is a comment. */
export function renderZone(plan: Plan): string {
	const out = [
		`; DNS records for ${plan.hostname}, and the domains it hosts.`,
		'; Publish them at your DNS host, then run bumail dns --check.',
	];
	for (const [scope, records, notes] of sections(plan)) {
		out.push(
			'',
			`; ${scope}${scope === plan.hostname ? ' (this server)' : ''}`,
			...records.map(line),
			...notes.map((note) => `; ${note.message}`),
		);
	}
	return `${out.join('\n')}\n`;
}

/** What `--json` prints: every record and note, and, with `--check`, what was found. */
export function renderJson(plan: Plan, checks?: readonly Checked[]): string {
	const records = plan.records.map(({ scope, purpose, optional, record }) => ({
		scope,
		purpose,
		optional,
		...record,
	}));
	const body = {
		hostname: plan.hostname,
		domains: plan.domains,
		records,
		notes: plan.notes,
		...(checks === undefined
			? {}
			: {
					checks: checks.map(({ wanted, ...result }) => ({
						scope: wanted.scope,
						purpose: wanted.purpose,
						...wanted.record,
						...result,
					})),
					ok: outcome(checks) === 'ok',
				}),
	};
	return `${JSON.stringify(body, null, '\t')}\n`;
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
			`  ${c.status.padEnd(12)}${record.type.padEnd(5)}${record.name}  ${clip(shown(c.wanted))}`,
		);
		if (c.status === 'differs' || c.status === 'duplicate') {
			for (const text of c.found)
				out.push(`${' '.repeat(19)}found  ${clip(text)}`);
		}
		if (c.detail !== undefined) out.push(`${' '.repeat(19)}${clip(c.detail)}`);
	}
	const count = (status: Status) =>
		checks.filter((c) => c.status === status).length;
	const problems = (['missing', 'differs', 'duplicate', 'unavailable'] as const)
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
