import { isIP } from 'node:net';
import { DnsError } from './errors';

const LABEL = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;

/** The control characters and spaces a name never holds. */
function hasControlOrSpace(name: string): boolean {
	for (const char of name) {
		const code = char.charCodeAt(0);
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

/** An ASCII character no host name holds: the URL parser would read `@`, `/`, `:`, `?`, `#` or `%` as syntax, not as part of the name. */
const NOT_IN_A_NAME = /[\x21-\x2c\x2f\x3a-\x40\x5b-\x5e\x60\x7b-\x7e]/;

/** A character the IDN mapping drops without a trace (a soft hyphen, a zero-width joiner…). */
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/u;

function invalid(name: string, why: string): DnsError {
	return new DnsError(
		'INVALID_NAME',
		`${JSON.stringify(name)} is not a name to look up: ${why}`,
	);
}

/**
 * The A-labels of a name holding non-ASCII characters, through the URL
 * API's IDN mapping (UTS #46). Only letters, digits, `.`, `-` and `_` are
 * left in ASCII by then, so the parser has no syntax to read; a mapping
 * that adds or removes a dot (`。`, U+3002) is refused too, so the name
 * queried has the labels the caller wrote.
 */
function idnOf(name: string, unicode: string): string {
	let ascii: string;
	try {
		ascii = new URL(`http://${unicode}`).hostname;
	} catch {
		throw invalid(name, 'it is not a valid international name');
	}
	if (ascii.split('.').length !== unicode.split('.').length)
		throw invalid(name, 'its IDN mapping changes its labels');
	return ascii;
}

/**
 * A name as it is queried: lowercase, no trailing dot, an IDN in its
 * A-labels (`bücher.example` → `xn--bcher-kva.example`), each label 1 to
 * 63 letters, digits, hyphens or underscores (`_dmarc`, `_domainkey`), 253
 * at most in all. Anything else throws `INVALID_NAME` — URL syntax (`@`,
 * `/`, `:`, `%`…) and characters the IDN mapping would drop included — so
 * a malformed name is never sent, nor swapped for another.
 */
export function normalizeName(name: unknown): string {
	if (typeof name !== 'string') {
		throw new DnsError(
			'INVALID_NAME',
			`A name to look up is a string, not ${typeof name}`,
		);
	}
	if (hasControlOrSpace(name))
		throw invalid(name, 'it holds a space or a control character');
	let ascii = name.endsWith('.') ? name.slice(0, -1) : name;
	if (isIP(ascii) !== 0)
		throw invalid(name, 'it is an address; look its name up with ptr()');
	const stray = NOT_IN_A_NAME.exec(ascii);
	if (stray !== null)
		throw invalid(
			name,
			`it holds ${JSON.stringify(stray[0])}, which no host name has`,
		);
	if (IGNORABLE.test(ascii))
		throw invalid(
			name,
			'it holds an invisible character the IDN mapping would drop',
		);
	if (/[^\x21-\x7e]/.test(ascii)) ascii = idnOf(name, ascii);
	ascii = ascii.toLowerCase();
	if (ascii.length === 0) throw invalid(name, 'it is empty');
	if (ascii.length > 253)
		throw invalid(name, 'it is longer than 253 characters');
	if (isIP(ascii) !== 0)
		throw invalid(name, 'it is an address; look its name up with ptr()');
	for (const label of ascii.split('.')) {
		if (!LABEL.test(label)) {
			throw invalid(
				name,
				label.length === 0
					? 'it has an empty label'
					: `the label ${JSON.stringify(label)} is not 1 to 63 letters, digits, hyphens or underscores`,
			);
		}
	}
	return ascii;
}

/**
 * An IP address as `ptr()` takes it: IPv4 as written, IPv6 in its canonical
 * form (`2001:0DB8:0:0::1` → `2001:db8::1`), so one address is one cache
 * and fixture key. A zone (`fe80::1%eth0`) or anything else is
 * `INVALID_NAME`.
 */
export function normalizeAddress(address: unknown): string {
	const version = typeof address === 'string' ? isIP(address) : 0;
	if (typeof address !== 'string' || version === 0 || address.includes('%')) {
		throw new DnsError(
			'INVALID_NAME',
			`${JSON.stringify(address)} is not an IPv4 or IPv6 address to look up`,
		);
	}
	if (version === 4) return address;
	return new URL(`http://[${address}]`).hostname.slice(1, -1);
}

/** A name a record points to (an MX exchange, a PTR target), as the interface returns it. */
export function targetName(name: string): string {
	const lower = name.toLowerCase();
	return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}
