import { isIP } from 'node:net';

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `name` is a fully qualified host name in A-labels: at least two
 * labels, each of letters, digits and inner hyphens, 253 characters at
 * most, lowercase. A trailing dot is the caller's to strip.
 */
export function isDomainName(name: string): boolean {
	if (name.length > 253) return false;
	const labels = name.split('.');
	return labels.length >= 2 && labels.every((label) => LABEL.test(label));
}

/** A host to connect to: a domain name, `localhost`, or an IP address. */
export function isHost(host: string): boolean {
	const name = host.toLowerCase().replace(/\.$/, '');
	return name === 'localhost' || isIP(host) !== 0 || isDomainName(name);
}

/** Whether a URL's host is this machine, where credentials never cross a network. */
export function isLoopback(hostname: string): boolean {
	const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
	return (
		host === 'localhost' ||
		host === '::1' ||
		(isIP(host) === 4 && host.startsWith('127.'))
	);
}
