import { AcmeError } from '../errors';

/** The most names `createCsr` puts in one request, Let's Encrypt's limit per certificate. */
export const MAX_NAMES = 100;
/** The longest name in its text form, without a trailing dot (RFC 1035 §2.3.4, less the root). */
const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

function quoted(name: string): string {
	return JSON.stringify(name.length > 80 ? `${name.slice(0, 80)}…` : name);
}

function invalid(message: string): AcmeError {
	return new AcmeError('INVALID_NAME', `createCsr(): ${message}`);
}

/**
 * One name for a certificate, checked and lowercased. Only a DNS host name
 * in ASCII: letters, digits and inner hyphens, labels of 1 to 63
 * characters, 253 at most, two labels at least, the last not numeric (so
 * an IPv4 address is refused). An internationalized name is refused, not
 * converted: it is given as its A-labels (`xn--…`), the form a CA issues
 * for. A wildcard is refused: HTTP-01 cannot prove one.
 */
export function checkName(name: unknown): string {
	if (typeof name !== 'string') {
		throw invalid(
			`a name is a string, not ${name === null ? 'null' : typeof name}`,
		);
	}
	if (!/^[\x21-\x7e]*$/.test(name)) {
		throw invalid(
			/^\p{ASCII}*$/u.test(name)
				? `${quoted(name)} holds a space or a control character`
				: `${quoted(name)} is not ASCII; give an internationalized name as its A-labels (xn--…)`,
		);
	}
	const lower = name.toLowerCase();
	if (lower.startsWith('*.') || lower === '*') {
		throw invalid(
			`${quoted(name)} is a wildcard name, which this package does not request`,
		);
	}
	if (lower.endsWith('.') && lower.length > 1) {
		throw invalid(`${quoted(name)} ends with a dot; give the name without it`);
	}
	if (lower.length > MAX_NAME_LENGTH) {
		throw invalid(
			`${quoted(name)} is longer than ${MAX_NAME_LENGTH} characters`,
		);
	}
	const labels = lower.split('.');
	for (const label of labels) {
		if (label === '') throw invalid(`${quoted(name)} has an empty label`);
		if (label.length > MAX_LABEL_LENGTH) {
			throw invalid(
				`${quoted(name)} has a label longer than ${MAX_LABEL_LENGTH} characters`,
			);
		}
		if (!LDH_LABEL.test(label)) {
			throw invalid(
				`${quoted(name)} has a label that is not letters, digits and inner hyphens: ${quoted(label)}`,
			);
		}
	}
	if (labels.length < 2) {
		throw invalid(
			`${quoted(name)} is a single label; a certificate name has at least two`,
		);
	}
	if (/^\d+$/.test(labels[labels.length - 1] ?? '')) {
		throw invalid(
			`${quoted(name)} ends in a numeric label, as an IP address does; only DNS names are supported`,
		);
	}
	return lower;
}

/** The names of a request, each checked, lowercased and given once. */
export function checkNames(names: unknown): string[] {
	if (!Array.isArray(names)) {
		throw new AcmeError(
			'INVALID_OPTION',
			'createCsr(): names must be an array of DNS names',
		);
	}
	if (names.length === 0) {
		throw new AcmeError(
			'INVALID_OPTION',
			'createCsr(): names must hold at least one name',
		);
	}
	if (names.length > MAX_NAMES) {
		throw new AcmeError(
			'INVALID_OPTION',
			`createCsr(): names holds ${names.length} names; at most ${MAX_NAMES} fit one certificate`,
		);
	}
	const seen = new Set<string>();
	for (const name of names) {
		const checked = checkName(name);
		if (seen.has(checked)) {
			throw new AcmeError(
				'INVALID_OPTION',
				`createCsr(): ${quoted(checked)} is given twice`,
			);
		}
		seen.add(checked);
	}
	return [...seen];
}
