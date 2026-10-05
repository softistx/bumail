import { isDmarcRecord, parseDmarcRecord, parseUri } from '../dmarc/record';
import type { DmarcPolicy } from '../dmarc/result';
import { AuthError } from '../errors';

/** What `dmarcRecord` writes. */
export interface DmarcRecordOptions {
	/** What a receiver does with mail that fails DMARC. */
	readonly p: DmarcPolicy;
	/** The policy for subdomains; the one of `p` when left out. */
	readonly sp?: DmarcPolicy;
	/** Where aggregate reports go: an address (`postmaster@example.com`) or a URI (`mailto:…`). */
	readonly rua?: string | readonly string[];
	/** Where failure reports go, written as `rua`. */
	readonly ruf?: string | readonly string[];
	/** The percentage of failing mail the policy applies to, 0 to 100. Default 100, which is not written. */
	readonly pct?: number;
	/** DKIM alignment: `'r'` relaxed (the default, not written) or `'s'` strict. */
	readonly adkim?: 'r' | 's';
	/** SPF alignment, written as `adkim`. */
	readonly aspf?: 'r' | 's';
}

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];

function refused(why: string): AuthError {
	return new AuthError('INVALID_OPTION', `dmarcRecord(): ${why}`);
}

function policy(name: string, value: unknown): string {
	if (typeof value !== 'string' || !POLICIES.includes(value)) {
		throw refused(
			`${name} must be one of none, quarantine, reject, not ${String(value)}`,
		);
	}
	return value;
}

function mode(name: string, value: unknown): string {
	if (value !== 'r' && value !== 's') {
		throw refused(`${name} must be 'r' or 's', not ${String(value)}`);
	}
	return value;
}

/** A report destination as the record writes it: an address gets `mailto:`, a URI is kept. */
function destination(name: string, text: unknown): string {
	if (typeof text !== 'string' || text === '') {
		throw refused(`${name} must hold addresses or URIs, as strings`);
	}
	const uri = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `mailto:${text}`;
	if (uri.toLowerCase().startsWith('mailto:') && !uri.includes('@')) {
		throw refused(`${name} "${text}" is not an e-mail address: it has no "@"`);
	}
	if (/[,;\s]/.test(uri) || parseUri(uri) === undefined) {
		throw refused(
			`${name} "${text}" is not an address or a URI (a "!10m" size may end it) without a comma, a semicolon or a space`,
		);
	}
	return uri;
}

function destinations(name: string, value: string | readonly string[]): string {
	const items = typeof value === 'string' ? [value] : value;
	if (!Array.isArray(items) || items.length === 0) {
		throw refused(`${name} must be an address, a URI, or a non-empty array`);
	}
	return `${name}=${items.map((item) => destination(name, item)).join(',')}`;
}

/**
 * A DMARC record's text (RFC 7489 §6.3), to publish as a TXT record at
 * `_dmarc.<domain>`: `v=DMARC1; p=…`, then the tags given, in the order
 * `sp`, `adkim`, `aspf`, `pct`, `rua`, `ruf`. A tag at its default
 * (`adkim=r`, `aspf=r`, `pct=100`) is left out.
 *
 * ```ts
 * dmarcRecord({ p: 'quarantine', adkim: 's', aspf: 's', rua: 'postmaster@example.com' });
 * // 'v=DMARC1; p=quarantine; adkim=s; aspf=s; rua=mailto:postmaster@example.com'
 * ```
 *
 * It throws `AuthError` `INVALID_OPTION` for a value outside what its tag
 * takes, and for a report address `parseDmarcRecord` would drop.
 */
export function dmarcRecord(options: DmarcRecordOptions): string {
	if (typeof options !== 'object' || options === null) {
		throw refused('options must be an object');
	}
	const tags = [`p=${policy('p', options.p)}`];
	if (options.sp !== undefined) tags.push(`sp=${policy('sp', options.sp)}`);
	if (options.adkim === 's') tags.push('adkim=s');
	else if (options.adkim !== undefined && options.adkim !== 'r') {
		mode('adkim', options.adkim);
	}
	if (options.aspf === 's') tags.push('aspf=s');
	else if (options.aspf !== undefined && options.aspf !== 'r') {
		mode('aspf', options.aspf);
	}
	const { pct } = options;
	if (pct !== undefined) {
		if (!Number.isInteger(pct) || pct < 0 || pct > 100) {
			throw refused(`pct must be an integer from 0 to 100, not ${pct}`);
		}
		if (pct !== 100) tags.push(`pct=${pct}`);
	}
	if (options.rua !== undefined) tags.push(destinations('rua', options.rua));
	if (options.ruf !== undefined) tags.push(destinations('ruf', options.ruf));
	const text = `v=DMARC1; ${tags.join('; ')}`;
	if (!isDmarcRecord(text) || parseDmarcRecord(text).p === undefined) {
		throw refused(`the record "${text}" is not one checkDmarc reads`);
	}
	return text;
}
