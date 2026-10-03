import { DnsError, type Resolver } from '@bumail/dns';
import { beforeDeadline } from '../deadline';
import { isDmarcRecord, parseDmarcRecord } from './record';
import type { DmarcPolicy, DmarcRecord } from './result';

/** The lookups' shared budget. */
export interface Lookup {
	readonly resolver: Resolver;
	/** When discovery gives up, in `performance.now()` milliseconds. */
	readonly deadline: number;
	readonly timeout: number;
}

/** What policy discovery (RFC 7489 §6.6.3) came to. */
export type Discovery =
	| {
			readonly record: DmarcRecord;
			readonly policyDomain: string;
			/** `p=`, or `sp=` for a subdomain under its organizational domain's record; `none` for a broken one with `rua=`. */
			readonly policy: DmarcPolicy;
	  }
	| {
			readonly result: 'none' | 'temperror' | 'permerror';
			readonly reason: string;
			readonly policyDomain?: string;
	  };

class Temporary {
	constructor(readonly reason: string) {}
}

/** The DMARC records at `_dmarc.<domain>`: none for no such name, a temporary failure thrown as `Temporary`. */
async function recordsAt(lookup: Lookup, domain: string): Promise<string[]> {
	const name = `_dmarc.${domain}`;
	try {
		const late = () =>
			new Temporary(
				`the check took longer than its timeout (${lookup.timeout} ms)`,
			);
		const answer = await beforeDeadline(
			lookup.resolver.txt(name),
			lookup.deadline,
			late,
		);
		return answer.map((r) => r.text).filter(isDmarcRecord);
	} catch (error) {
		if (error instanceof Temporary) throw error;
		if (error instanceof DnsError) {
			if (error.code === 'NOT_FOUND' || error.code === 'INVALID_NAME') {
				return [];
			}
			throw new Temporary(`DNS lookup failed: ${error.code} for TXT ${name}`);
		}
		throw new Temporary(`DNS lookup failed: ${String(error)} for TXT ${name}`);
	}
}

function brokenPolicy(
	record: DmarcRecord,
	policyDomain: string,
): Discovery | undefined {
	if (record.p !== undefined && !record.invalidSp) return undefined;
	if (record.rua.length > 0) return { record, policyDomain, policy: 'none' };
	const what = record.p === undefined ? 'no valid p=' : 'an invalid sp=';
	return {
		result: 'permerror',
		reason: `the DMARC record at _dmarc.${policyDomain} has ${what}, and no rua=`,
		policyDomain,
	};
}

/**
 * The record at the From domain, or else at its organizational domain;
 * the policy it sets for `from`. Several records, a temporary DNS failure
 * or a record with no valid policy and no `rua=` end it.
 */
export async function discover(
	lookup: Lookup,
	from: string,
	org: string,
): Promise<Discovery> {
	try {
		let policyDomain = from;
		let found = await recordsAt(lookup, from);
		if (found.length === 0 && org !== from) {
			policyDomain = org;
			found = await recordsAt(lookup, org);
		}
		if (found.length === 0) {
			const where = org === from ? '' : ` or _dmarc.${org}`;
			return {
				result: 'none',
				reason: `no DMARC record at _dmarc.${from}${where}`,
			};
		}
		if (found.length > 1) {
			return {
				result: 'permerror',
				reason: `more than one DMARC record at _dmarc.${policyDomain}`,
				policyDomain,
			};
		}
		const record = parseDmarcRecord(found[0] ?? '');
		const broken = brokenPolicy(record, policyDomain);
		if (broken !== undefined) return broken;
		const subdomain = policyDomain !== from;
		const policy = (subdomain ? record.sp : undefined) ?? record.p ?? 'none';
		return { record, policyDomain, policy };
	} catch (error) {
		if (!(error instanceof Temporary)) throw error;
		return { result: 'temperror', reason: error.reason };
	}
}
