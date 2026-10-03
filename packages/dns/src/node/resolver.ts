import { DnsError } from '../errors';
import { normalizeAddress, normalizeName, targetName } from '../name';
import type {
	AddressRecord,
	MxRecord,
	PtrRecord,
	Resolver,
	TxtRecord,
} from '../types';
import { type NodeResolverOptions, nodeBackend } from './backend';
import { dnsErrorOf } from './errors';

function checkOptions(options: NodeResolverOptions): number {
	const assumedTtl = options.assumedTtl ?? 300;
	if (!Number.isInteger(assumedTtl) || assumedTtl < 0) {
		throw new DnsError(
			'INVALID_OPTION',
			`nodeResolver(): assumedTtl must be an integer of at least 0, not ${String(options.assumedTtl)}`,
		);
	}
	return assumedTtl;
}

/** The answer, or the `DnsError` for what was thrown; an empty answer is `NOT_FOUND` too. */
async function query<T>(label: string, run: () => Promise<T[]>): Promise<T[]> {
	let records: T[];
	try {
		records = await run();
	} catch (error) {
		throw dnsErrorOf(error, label);
	}
	if (records.length === 0)
		throw new DnsError('NOT_FOUND', `No ${label} record (empty answer)`);
	return records;
}

/**
 * A `Resolver` on `node:dns/promises`. A and AAAA answers carry the TTL the
 * DNS gave; MX, TXT and PTR carry `assumedTtl`, since `node:dns` does not
 * report theirs (and an ANY query, RFC 8482, is no way to learn it).
 */
export function nodeResolver(options: NodeResolverOptions = {}): Resolver {
	const assumedTtl = checkOptions(options);
	const backend = options.backend ?? nodeBackend(options);
	return {
		async mx(name): Promise<readonly MxRecord[]> {
			const domain = normalizeName(name);
			const records = await query(`MX ${domain}`, () =>
				backend.resolveMx(domain),
			);
			return records
				.map((record) => ({
					exchange: targetName(record.exchange),
					priority: record.priority,
					ttl: assumedTtl,
				}))
				.sort((a, b) => a.priority - b.priority);
		},
		async txt(name): Promise<readonly TxtRecord[]> {
			const domain = normalizeName(name);
			const records = await query(`TXT ${domain}`, () =>
				backend.resolveTxt(domain),
			);
			return records.map((chunks) => ({
				text: chunks.join(''),
				ttl: assumedTtl,
			}));
		},
		async a(name): Promise<readonly AddressRecord[]> {
			const domain = normalizeName(name);
			const records = await query(`A ${domain}`, () =>
				backend.resolve4(domain, { ttl: true }),
			);
			return records.map(({ address, ttl }) => ({ address, ttl }));
		},
		async aaaa(name): Promise<readonly AddressRecord[]> {
			const domain = normalizeName(name);
			const records = await query(`AAAA ${domain}`, () =>
				backend.resolve6(domain, { ttl: true }),
			);
			return records.map(({ address, ttl }) => ({ address, ttl }));
		},
		async ptr(address): Promise<readonly PtrRecord[]> {
			const ip = normalizeAddress(address);
			const names = await query(`PTR ${ip}`, () => backend.reverse(ip));
			return names.map((name) => ({ name: targetName(name), ttl: assumedTtl }));
		},
	};
}
