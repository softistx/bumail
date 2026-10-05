import { dmarcRecord, spfRecord } from '@bumail/auth';
import type { ZoneRecord } from '@bumail/dns';
import type { ServerConfig } from '../../config/types';
import type { Directory } from '../../directory/directory';

/** What a record is for. */
export type Purpose = 'host' | 'mx' | 'spf' | 'dkim' | 'dmarc' | 'srv' | 'caa';

/** One record to publish. */
export interface Wanted {
	/** The host name or the domain it belongs to. */
	readonly scope: string;
	readonly purpose: Purpose;
	/** Optional records are printed commented out, and never checked. */
	readonly optional: boolean;
	readonly record: ZoneRecord;
}

/** Something to do by hand, which no record says. */
export interface Note {
	readonly scope: string;
	readonly message: string;
}

/** Everything `bumail dns` has to say. */
export interface Plan {
	readonly hostname: string;
	readonly domains: readonly string[];
	readonly records: readonly Wanted[];
	readonly notes: readonly Note[];
	/** Whether `--ip` gave the server's IPv4 address: if not, `--check` only asks that the host name resolve. */
	readonly hasIp: boolean;
}

/** What the operator tells `bumail dns` of the server's addresses. */
export interface Addresses {
	readonly ip: string | undefined;
	readonly ip6: string | undefined;
}

/**
 * The DMARC default: `quarantine` rather than `none` (which protects no
 * one) or `reject` (which loses real mail while a record is still wrong),
 * and strict alignment, which bumail's own mail always meets: it signs
 * with `d=` the From domain, and sends from a MAIL FROM of that domain.
 */
const DMARC = { p: 'quarantine', adkim: 's', aspf: 's' } as const;

/** Let's Encrypt's CAA `issue` value, for the ACME directories that name it. */
const LETS_ENCRYPT = 'letsencrypt.org';

/** The CA an ACME directory belongs to, as a CAA `issue` value; `undefined` for one this does not know. */
function issuer(directory: string): string | undefined {
	return new URL(directory).hostname.endsWith('letsencrypt.org')
		? LETS_ENCRYPT
		: undefined;
}

function hostRecords(config: ServerConfig, addresses: Addresses): Wanted[] {
	const { hostname } = config;
	const out: Wanted[] = [];
	const add = (purpose: Purpose, record: ZoneRecord, optional = false) =>
		out.push({ scope: hostname, purpose, optional, record });
	if (addresses.ip !== undefined) {
		add('host', { name: hostname, type: 'A', value: addresses.ip });
	}
	if (addresses.ip6 !== undefined) {
		add('host', { name: hostname, type: 'AAAA', value: addresses.ip6 });
	}
	if (config.acme !== undefined) {
		const ca = issuer(config.acme.directory);
		if (ca !== undefined) {
			add('caa', { name: hostname, type: 'CAA', value: `0 issue ${ca}` }, true);
		}
	}
	return out;
}

/** The SRV records of RFC 6186 and RFC 8620 §2.2 for each service the server offers. */
function autoconfig(config: ServerConfig, domain: string): Wanted[] {
	const jmap = new URL(config.jmap.origin);
	const services: [string, number, string][] = [
		['_submissions._tcp', config.ports.submissions, config.hostname],
		['_imaps._tcp', config.ports.imaps, config.hostname],
		[
			'_jmap._tcp',
			config.ports.https === 0 ? 0 : Number(jmap.port || 443),
			jmap.hostname,
		],
	];
	return services
		.filter(([, port]) => port !== 0)
		.map(([service, port, host]) => ({
			scope: domain,
			purpose: 'srv',
			optional: false,
			record: {
				name: `${service}.${domain}`,
				type: 'SRV',
				priority: 0,
				value: `1 ${port} ${host}`,
			},
		}));
}

function domainRecords(
	config: ServerConfig,
	directory: Directory,
	domain: string,
	notes: Note[],
): Wanted[] {
	const wanted = (purpose: Purpose, record: ZoneRecord): Wanted => ({
		scope: domain,
		purpose,
		optional: false,
		record,
	});
	const out: Wanted[] = [
		wanted('mx', {
			name: domain,
			type: 'MX',
			priority: 10,
			value: config.hostname,
		}),
		wanted('spf', {
			name: domain,
			type: 'TXT',
			value: spfRecord({ mx: true }),
		}),
	];
	if (config.smarthost !== undefined) {
		notes.push({
			scope: domain,
			message: `outbound mail goes through the smarthost ${config.smarthost.host}: add its SPF include to the SPF record above, as its provider says`,
		});
	}
	const key = directory.dkim.get(domain);
	if (key === undefined) {
		notes.push({
			scope: domain,
			message: `no DKIM key yet: bumail dkim generate ${domain} makes one, and bumail dns prints its record`,
		});
	} else {
		out.push(
			wanted('dkim', {
				name: key.name,
				type: 'TXT',
				value: key.record,
			}),
		);
	}
	const reports = directory.resolve(`postmaster@${domain}`) !== undefined;
	out.push(
		wanted('dmarc', {
			name: `_dmarc.${domain}`,
			type: 'TXT',
			value: dmarcRecord({
				...DMARC,
				...(reports ? { rua: `postmaster@${domain}` } : {}),
			}),
		}),
	);
	return [...out, ...autoconfig(config, domain)];
}

/** The records for `domains`, hosted ones, and the notes that go with them. */
export function plan(
	config: ServerConfig,
	directory: Directory,
	domains: readonly string[],
	addresses: Addresses,
): Plan {
	const notes: Note[] = [];
	if (addresses.ip === undefined) {
		notes.push({
			scope: config.hostname,
			message: `its A record is the server's public IPv4 address, which the server cannot know: run bumail dns --ip <address>, or add ${config.hostname}. IN A <address> yourself`,
		});
	}
	if (addresses.ip6 === undefined) {
		notes.push({
			scope: config.hostname,
			message:
				'optional: if the server has a public IPv6 address, bumail dns --ip6 <address> writes its AAAA record',
		});
	}
	const records = [
		...hostRecords(config, addresses),
		...domains.flatMap((domain) =>
			domainRecords(config, directory, domain, notes),
		),
	];
	return {
		hostname: config.hostname,
		domains,
		records,
		notes,
		hasIp: addresses.ip !== undefined,
	};
}
