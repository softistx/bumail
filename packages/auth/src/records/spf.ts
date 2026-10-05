import { DNS_NAME } from '../dkim/names';
import { AuthError } from '../errors';
import { parseIp4, parseIp6 } from '../spf/ip';
import { isSpfRecord, parseRecord } from '../spf/record';

/** What `spfRecord` writes. */
export interface SpfRecordOptions {
	/** Allow the hosts in the domain's MX records (`mx`). */
	readonly mx?: boolean;
	/** Allow the domain's own A and AAAA addresses (`a`). */
	readonly a?: boolean;
	/** Domains whose SPF record also counts (`include:`), each a DNS lookup. */
	readonly include?: readonly string[];
	/** IPv4 addresses or networks (`ip4:192.0.2.0/24`). */
	readonly ip4?: readonly string[];
	/** IPv6 addresses or networks (`ip6:2001:db8::/32`). */
	readonly ip6?: readonly string[];
	/** What a sender no term matched gets. Default `-all`: refuse. */
	readonly all?: '-all' | '~all' | '?all' | '+all';
}

const ALL = ['-all', '~all', '?all', '+all'];

/** RFC 7208 §4.6.4: at most 10 terms that query the DNS. */
const MAX_LOOKUPS = 10;

function refused(why: string): AuthError {
	return new AuthError('INVALID_OPTION', `spfRecord(): ${why}`);
}

/** The strings of an option, or why it is not a list of them. */
function listOf(name: string, value: readonly string[] | undefined) {
	if (value === undefined) return [];
	if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
		throw refused(`${name} must be an array of strings`);
	}
	return value;
}

/** `192.0.2.0/24` as `ip4` or `ip6` takes it: the address, and an optional prefix length. */
function network(kind: 'ip4' | 'ip6', text: string): string {
	const slash = text.indexOf('/');
	const address = slash < 0 ? text : text.slice(0, slash);
	const prefix = slash < 0 ? undefined : text.slice(slash + 1);
	const max = kind === 'ip4' ? 32 : 128;
	const parsed = kind === 'ip4' ? parseIp4(address) : parseIp6(address);
	const badPrefix =
		prefix !== undefined &&
		!(/^(?:0|[1-9][0-9]{0,2})$/.test(prefix) && Number(prefix) <= max);
	if (parsed === undefined || badPrefix) {
		throw refused(
			`${kind} "${text}" is not an ${kind === 'ip4' ? 'IPv4' : 'IPv6'} address, or a network such as ${kind === 'ip4' ? '192.0.2.0/24' : '2001:db8::/32'}`,
		);
	}
	return text;
}

function mechanisms(options: SpfRecordOptions): string[] {
	const terms: string[] = [];
	if (options.a === true) terms.push('a');
	if (options.mx === true) terms.push('mx');
	for (const domain of listOf('include', options.include)) {
		if (!DNS_NAME.test(domain)) {
			throw refused(`include "${domain}" is not a domain name`);
		}
		terms.push(`include:${domain}`);
	}
	for (const text of listOf('ip4', options.ip4)) {
		terms.push(`ip4:${network('ip4', text)}`);
	}
	for (const text of listOf('ip6', options.ip6)) {
		terms.push(`ip6:${network('ip6', text)}`);
	}
	return terms;
}

/**
 * An SPF record's text (RFC 7208 §4.5), to publish as a TXT record at the
 * domain: `v=spf1`, then `a`, `mx`, the `include:`s, the `ip4:`s and the
 * `ip6:`s in that order, then `all` (default `-all`).
 *
 * ```ts
 * spfRecord({ mx: true }); // 'v=spf1 mx -all'
 * spfRecord({ mx: true, include: ['_spf.relay.example'], all: '~all' });
 * // 'v=spf1 mx include:_spf.relay.example ~all'
 * ```
 *
 * It throws `AuthError` `INVALID_OPTION` for an address or a domain that
 * is not one, a qualifier other than the four, and a record that would
 * make more than 10 DNS lookups, which a receiver answers `permerror`.
 * What it returns is read back by `checkSpf` as it was written.
 */
export function spfRecord(options: SpfRecordOptions): string {
	if (typeof options !== 'object' || options === null) {
		throw refused('options must be an object');
	}
	const all = options.all ?? '-all';
	if (!ALL.includes(all)) {
		throw refused(`all must be one of ${ALL.join(', ')}, not ${String(all)}`);
	}
	const terms = mechanisms(options);
	const lookups =
		(options.a === true ? 1 : 0) +
		(options.mx === true ? 1 : 0) +
		listOf('include', options.include).length;
	if (lookups > MAX_LOOKUPS) {
		throw refused(
			`a, mx and include make ${lookups} DNS lookups, more than the ${MAX_LOOKUPS} RFC 7208 §4.6.4 allows`,
		);
	}
	const text = ['v=spf1', ...terms, all].join(' ');
	if (!isSpfRecord(text) || typeof parseRecord(text) === 'string') {
		throw refused(`the record "${text}" is not one checkSpf reads`);
	}
	return text;
}
