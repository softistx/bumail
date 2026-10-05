import { formatZone } from '@bumail/dns';
import type { Checked } from './check';
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
					ok: checks.every(
						(c) => c.status === 'ok' || c.status === 'unchecked',
					),
				}),
	};
	return `${JSON.stringify(body, null, '\t')}\n`;
}
