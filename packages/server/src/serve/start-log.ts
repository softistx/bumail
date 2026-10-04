import type { ServerConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import { descriptionOf } from './listeners';
import type { Log } from './log';
import { envelopeDomain } from './recipients';
import type { Listening } from './serve';

/** The start's log: the server's name, one line per listener. */
export function logStart(
	config: ServerConfig,
	listening: readonly Listening[],
	log: Log,
): void {
	log(`bumail: serving ${config.hostname}`);
	for (const { name, hostname, port } of listening) {
		log(
			`bumail: ${name} listening on ${hostname}:${port}: ${descriptionOf(name, config)}`,
		);
	}
}

/**
 * Warns when `postmaster` is in a domain the server does not host: the
 * bare `<postmaster>` goes nowhere, and is refused, until it is.
 */
export function warnPostmaster(
	config: ServerConfig,
	directory: Directory,
	log: Log,
): void {
	const { postmaster } = config;
	if (postmaster === undefined) return;
	const domain = envelopeDomain(postmaster);
	if (directory.domains.has(domain)) return;
	log(
		`bumail: postmaster ${postmaster} is in ${domain}, a domain not hosted here; mail for <postmaster> is refused until it is`,
	);
}
