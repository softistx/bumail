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

function invalid(name: string, why: string): DnsError {
	return new DnsError(
		'INVALID_NAME',
		`${JSON.stringify(name)} is not a name to look up: ${why}`,
	);
}

/**
 * A name as it is queried: lowercase, no trailing dot, an IDN in its
 * A-labels (`bücher.example` → `xn--bcher-kva.example`), each label 1 to
 * 63 letters, digits, hyphens or underscores (`_dmarc`, `_domainkey`), 253
 * at most in all. Anything else throws `INVALID_NAME`, so a malformed name
 * is never sent.
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
	if (/[^\x21-\x7e]/.test(ascii)) {
		try {
			ascii = new URL(`http://${ascii}`).hostname;
		} catch {
			throw invalid(name, 'it is not a valid international name');
		}
	}
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

/** An IP address as `ptr()` takes it, or `INVALID_NAME`. */
export function normalizeAddress(address: unknown): string {
	if (typeof address !== 'string' || isIP(address) === 0) {
		throw new DnsError(
			'INVALID_NAME',
			`${JSON.stringify(address)} is not an IPv4 or IPv6 address to look up`,
		);
	}
	return address.toLowerCase();
}

/** A name a record points to (an MX exchange, a PTR target), as the interface returns it. */
export function targetName(name: string): string {
	const lower = name.toLowerCase();
	return lower.endsWith('.') ? lower.slice(0, -1) : lower;
}
