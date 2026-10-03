import { SmtpError } from '../errors';
import type { MxResolver } from './options';

/** A host that takes mail for a domain, by preference: the lowest first. */
export interface MailHost {
	readonly host: string;
	readonly priority: number;
	/** No MX record: the domain itself, by its A or AAAA (RFC 5321 §5.1). */
	readonly implicit: boolean;
}

/** A `DnsError`'s code, read by shape: the client imports nothing of `@bumail/dns` at runtime. */
function dnsCode(error: unknown): string | undefined {
	return error instanceof Error && error.name === 'DnsError'
		? (error as Error & { code?: string }).code
		: undefined;
}

/** As `@bumail/dns`'s `isTemporary`: only "no such record" and a refused name are permanent. */
function temporary(error: unknown): boolean {
	const code = dnsCode(error);
	return code !== 'NOT_FOUND' && code !== 'INVALID_NAME';
}

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/** By preference, equal ones in a random order, as RFC 5321 §5.1 asks, to spread the load. */
function byPreference(hosts: readonly MailHost[]): MailHost[] {
	return hosts
		.map((host) => ({ host, key: Math.random() }))
		.sort((x, y) => x.host.priority - y.host.priority || x.key - y.key)
		.map(({ host }) => host);
}

/**
 * The hosts to deliver a domain's mail to, in the order to try them (RFC
 * 5321 §5.1): its MX records by preference, or the domain itself when it
 * has none. A null MX (RFC 7505) is a permanent `NULL_MX`; a lookup that
 * failed is `DNS_FAILED`, temporary unless the DNS said there is no such
 * domain.
 */
export async function resolveMx(
	domain: string,
	resolver: Pick<MxResolver, 'mx'>,
): Promise<MailHost[]> {
	let records: Awaited<ReturnType<MxResolver['mx']>>;
	try {
		records = await resolver.mx(domain);
	} catch (error) {
		if (dnsCode(error) === 'NOT_FOUND') {
			return [{ host: domain.toLowerCase(), priority: 0, implicit: true }];
		}
		throw new SmtpError(
			'DNS_FAILED',
			`Could not look up the MX records of ${domain}: ${messageOf(error)}`,
			{ temporary: temporary(error) },
		);
	}
	const hosts = records
		.filter((record) => record.exchange !== '')
		.map((record) => ({
			host: record.exchange,
			priority: record.priority,
			implicit: false,
		}));
	if (hosts.length === 0) {
		throw new SmtpError(
			'NULL_MX',
			`${domain} accepts no mail: its MX record is the null MX (RFC 7505)`,
			{ temporary: false },
		);
	}
	return byPreference(hosts);
}

/** A host's addresses, IPv4 first; an error when it has none. */
export async function addressesOf(
	host: string,
	resolver: Pick<MxResolver, 'a' | 'aaaa'>,
): Promise<string[] | { readonly error: unknown }> {
	const found: string[] = [];
	let failure: unknown;
	for (const lookup of [resolver.a, resolver.aaaa]) {
		try {
			for (const record of await lookup.call(resolver, host)) {
				found.push(record.address);
			}
		} catch (error) {
			if (failure === undefined || temporary(error)) failure = error;
		}
	}
	return found.length > 0 ? found : { error: failure };
}

/** `DNS_FAILED` for a domain none of whose hosts had an address. */
export function noAddress(domain: string, error: unknown): SmtpError {
	return new SmtpError(
		'DNS_FAILED',
		`No mail host of ${domain} has an address: ${messageOf(error)}`,
		{ temporary: temporary(error) },
	);
}
