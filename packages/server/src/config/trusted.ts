import { trustedPeers } from '../proxy/trusted';
import type { Checker, Table } from './checker';

/**
 * Checks a list of proxies, `trusted`, at least one entry, at `path`,
 * with the rules `@bumail/smtp` and `@bumail/imap` apply, whose code
 * (`src/proxy/trusted.ts`) it runs on each entry: so whatever they
 * refuse at start is a line of `check-config`, never an error thrown
 * by a listener. An entry is refused when it is not an IP address or a
 * CIDR (a host name, a second `/`), has a zone (`fe80::1%eth0`), has a
 * prefix out of range or below 96 for an IPv4-mapped address, or a
 * prefix of 0, which trusts every peer.
 *
 * No problem repeats an entry, only its place in the list. Answers the
 * list as written, `[]` when there is a problem.
 */
export function checkTrusted(
	checker: Checker,
	table: Table | undefined,
	key: string,
	path: string,
): readonly string[] {
	const where = `${path}.${key}`;
	const value = table?.[key];
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.length === 0) {
		checker.add(
			where,
			'must list the addresses or CIDRs of the proxies, at least one',
		);
		return [];
	}
	const before = checker.problems.length;
	value.forEach((entry: unknown, index) => {
		const problem = problemOf(entry);
		if (problem !== undefined) checker.add(`${where}[${index}]`, problem);
	});
	return checker.problems.length === before ? (value as string[]) : [];
}

/** What smtp's rules say of one entry, without the entry, or `undefined`. */
function problemOf(entry: unknown): string | undefined {
	if (typeof entry !== 'string') return 'is not a string';
	try {
		trustedPeers([entry], (message) => new Error(message));
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : '';
		// The exact prefix, entry included, which may hold a quote itself.
		const prefix = `proxyProtocol.trusted: "${entry}" `;
		return message.startsWith(prefix)
			? message.slice(prefix.length)
			: 'is neither an IP address nor a CIDR';
	}
}
