import { isIP } from 'node:net';
import type { Checker, Table } from './checker';

/**
 * Checks a list of proxies, `trusted`, at `path`: an array of IPv4 or
 * IPv6 addresses and CIDRs, at least one. As `@bumail/smtp` and
 * `@bumail/imap` take such a list, an entry is refused when it:
 *
 * - is not an IP address or a CIDR (a host name, a second `/`);
 * - has a zone (`fe80::1%eth0`), which names an interface of this host;
 * - has a prefix out of range, or below 96 for an IPv4-mapped address;
 * - has a prefix of 0, which trusts every peer.
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
		const problem =
			typeof entry === 'string' ? entryProblem(entry) : 'is not a string';
		if (problem !== undefined) checker.add(`${where}[${index}]`, problem);
	});
	return checker.problems.length === before ? (value as string[]) : [];
}

/** What is wrong with one entry, or `undefined`. */
function entryProblem(entry: string): string | undefined {
	const parts = entry.split('/');
	const address = parts[0] ?? '';
	const family = address.includes('%') ? 0 : isIP(address);
	if (parts.length > 2 || family === 0) {
		return 'is neither an IP address nor a CIDR';
	}
	if (parts.length === 1) return undefined;
	const prefix = parts[1] ?? '';
	if (!/^\d{1,3}$/.test(prefix)) return 'has a prefix length out of range';
	const length = Number(prefix);
	if (length === 0) {
		return 'has a prefix length of 0, which trusts every peer';
	}
	const mapped = family === 6 && /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(address);
	const least = mapped ? 96 : 0;
	const most = family === 4 ? 32 : 128;
	if (length < least || length > most) {
		return 'has a prefix length out of range';
	}
	return undefined;
}
