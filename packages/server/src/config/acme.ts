import { isIP } from 'node:net';
import { MAX_NAMES } from '@bumail/acme';
import type { Checker } from './checker';
import { isDomainName } from './names';
import type { AcmeConfig } from './types';
import { checkHttpsUrl } from './urls';

/** Let's Encrypt's production directory (RFC 8555 §7.1.1). */
export const LETS_ENCRYPT = 'https://acme-v02.api.letsencrypt.org/directory';

/** Let's Encrypt's staging directory, which `directory = "staging"` stands for. */
export const STAGING = 'https://acme-staging-v02.api.letsencrypt.org/directory';

/** Days before the end of a certificate's life at which it is renewed, by default. */
export const DEFAULT_RENEW_BEFORE_DAYS = 30;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const KEYS = [
	'email',
	'acceptTerms',
	'directory',
	'names',
	'dir',
	'renewBeforeDays',
	'bind',
];

/** What `checkAcme` needs besides the table. */
export interface AcmeContext {
	/** `undefined` when it is missing or invalid. */
	readonly hostname: string | undefined;
	readonly data: string;
	readonly bind: string;
}

/**
 * `[acme]`: `acceptTerms = true` is required; `email` is optional;
 * `directory` is an `https:` URL or `"staging"`; `names` are extra DNS
 * names, none a wildcard (HTTP-01 cannot prove one); `dir` an absolute
 * path; `renewBeforeDays` 1 to 365; `bind` an IP address.
 */
export function checkAcme(
	checker: Checker,
	raw: unknown,
	context: AcmeContext,
): AcmeConfig {
	const acme = checker.table(raw, 'acme', KEYS);
	const email = checker.string(acme, 'email', 'acme');
	if (email !== undefined && !EMAIL.test(email)) {
		checker.add('acme.email', 'must be an e-mail address');
	}
	const accepted = checker.boolean(acme, 'acceptTerms', 'acme');
	// Not a boolean is already recorded; false and absent are refused here.
	if (accepted === false || acme?.['acceptTerms'] === undefined) {
		checker.add(
			'acme.acceptTerms',
			"must be true: the CA's terms of service, read and accepted",
		);
	}
	return {
		email: email !== undefined && EMAIL.test(email) ? email : undefined,
		acceptTerms: true,
		directory: directoryOf(checker, acme?.['directory']),
		names: namesOf(checker, acme?.['names'], context.hostname),
		dir: dirOf(checker, acme?.['dir'], context.data),
		renewBeforeDays:
			checker.integer(acme, 'renewBeforeDays', 'acme', 1, 365) ??
			DEFAULT_RENEW_BEFORE_DAYS,
		bind: bindOf(checker, acme?.['bind'], context.bind),
	};
}

function directoryOf(checker: Checker, value: unknown): string {
	if (value === undefined) return LETS_ENCRYPT;
	if (typeof value !== 'string') {
		checker.add('acme.directory', 'must be a string');
		return LETS_ENCRYPT;
	}
	if (value === 'staging') return STAGING;
	return checkHttpsUrl(checker, value, 'acme.directory', false) ?? LETS_ENCRYPT;
}

/** `hostname` first, then the extra names, lowercase and without a trailing dot, each once. */
function namesOf(
	checker: Checker,
	value: unknown,
	hostname: string | undefined,
): string[] {
	const names = hostname === undefined ? [] : [hostname];
	if (value === undefined) return names;
	if (!Array.isArray(value)) {
		checker.add('acme.names', 'must be an array of DNS names');
		return names;
	}
	value.forEach((item: unknown, index) => {
		const path = `acme.names[${index}]`;
		if (typeof item !== 'string') {
			checker.add(path, 'must be a string');
			return;
		}
		const name = item.toLowerCase().replace(/\.$/, '');
		if (name.startsWith('*.')) {
			checker.add(path, 'is a wildcard, which HTTP-01 cannot prove');
		} else if (!isDomainName(name) || isIP(name) !== 0) {
			checker.add(
				path,
				'must be a fully qualified domain name, such as imap.example.com',
			);
		} else if (!names.includes(name)) {
			names.push(name);
		}
	});
	if (names.length > MAX_NAMES) {
		checker.add(
			'acme.names',
			`are more than the ${MAX_NAMES} a certificate holds`,
		);
	}
	return names;
}

/** `acme.dir`, absolute, without a trailing slash. Default `<data>/acme`. */
function dirOf(checker: Checker, value: unknown, data: string): string {
	const fallback = `${data === '/' ? '' : data}/acme`;
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || !value.startsWith('/')) {
		checker.add('acme.dir', 'must be an absolute path');
		return fallback;
	}
	return value.replace(/\/+$/, '') || '/';
}

function bindOf(checker: Checker, value: unknown, fallback: string): string {
	if (value === undefined) return fallback;
	if (typeof value !== 'string' || isIP(value) === 0) {
		checker.add('acme.bind', 'must be an IPv4 or IPv6 address');
		return fallback;
	}
	return value;
}
