import { parseKeyRecord } from '../dkim/key';
import { isDmarcRecord, parseDmarcRecord } from '../dmarc/record';
import { ipText } from '../spf/ip';
import {
	isSpfRecord,
	type Mechanism,
	parseRecord,
	type SpfRecord,
} from '../spf/record';

/** A mechanism as one canonical string: lowercase, `+` and default CIDR lengths left out. */
function term(m: Mechanism): string {
	const q = m.qualifier === '+' ? '' : m.qualifier;
	switch (m.kind) {
		case 'all':
			return `${q}all`;
		case 'ip4':
		case 'ip6':
			return `${q}${m.kind}:${ipText(m.network)}/${m.prefix}`;
		case 'a':
		case 'mx': {
			const target =
				m.target === undefined ? '' : `:${JSON.stringify(m.target)}`;
			const cidr4 = m.cidr4 === 32 ? '' : `/${m.cidr4}`;
			const cidr6 = m.cidr6 === 128 ? '' : `//${m.cidr6}`;
			return `${q}${m.kind}${target}${cidr4}${cidr6}`.toLowerCase();
		}
		default:
			return `${q}${m.kind}:${JSON.stringify(m.target ?? '')}`.toLowerCase();
	}
}

function spfForm(text: string): string | undefined {
	if (!isSpfRecord(text)) return undefined;
	const record: SpfRecord | string = parseRecord(text);
	if (typeof record === 'string') return undefined;
	return JSON.stringify([
		record.mechanisms.map(term),
		JSON.stringify(record.redirect ?? null).toLowerCase(),
		JSON.stringify(record.exp ?? null).toLowerCase(),
	]);
}

function same(a: string | undefined, b: string | undefined): boolean {
	return a !== undefined && a === b;
}

/**
 * Whether two texts are the same SPF record, read as `checkSpf` reads
 * them: white space between terms, case, a leading `+` and default CIDR
 * lengths (`mx/32`) do not matter; the order of the terms does, since the
 * first to match decides. `false` when either is not a record `checkSpf`
 * can read.
 */
export function sameSpfRecord(a: string, b: string): boolean {
	return same(spfForm(a), spfForm(b));
}

function dmarcForm(text: string): string | undefined {
	return isDmarcRecord(text)
		? JSON.stringify(parseDmarcRecord(text))
		: undefined;
}

/**
 * Whether two texts are the same DMARC record, as `checkDmarc` reads
 * them: white space, the case of tag names and of `s`/`r`, and a tag at
 * its default (`adkim=r`, `pct=100`) do not matter. `false` when either
 * does not start with `v=DMARC1`.
 */
export function sameDmarcRecord(a: string, b: string): boolean {
	return same(dmarcForm(a), dmarcForm(b));
}

function keyForm(text: string): string | undefined {
	const record = parseKeyRecord(text);
	if (record === undefined) return undefined;
	return JSON.stringify([
		record.type,
		record.publicKey,
		record.hashes === undefined ? null : [...record.hashes].sort(),
		[...record.services].sort(),
		[...record.flags].sort(),
	]);
}

/**
 * Whether two texts are the same DKIM key record, as `verifyDkim` reads
 * them: white space, an implied `k=rsa` and the order of the tags do not
 * matter. `false` when either is not a key record.
 */
export function sameDkimRecord(a: string, b: string): boolean {
	return same(keyForm(a), keyForm(b));
}
