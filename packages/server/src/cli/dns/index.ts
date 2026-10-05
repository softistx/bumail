import { AuthError } from '@bumail/auth';
import { DnsError, nodeResolver, type Resolver } from '@bumail/dns';
import type { ServerConfig } from '../../config/types';
import { domainOf } from '../../directory/address';
import { directoryFile } from '../../directory/database';
import { Directory } from '../../directory/directory';
import { ServerError } from '../../errors';
import type { DnsArgs } from './args';
import { check, outcome } from './check';
import { type Plan, plan } from './plan';
import { renderChecks, renderJson, renderZone } from './render';

/** What `bumail dns` writes to, and, for `--check`, asks. */
export interface DnsIo {
	readonly out: (text: string) => void;
	/** The DNS `--check` queries; default `node:dns`. */
	readonly resolver?: Resolver;
}

/** Seconds a `--check` query may take, and its tries: an operator waits for the answer. */
const TIMEOUT_MS = 5000;
const TRIES = 2;

/** The domains to write records for: the one named, which must be hosted, or every hosted one. */
function domainsOf(directory: Directory, named: string | undefined): string[] {
	const hosted = directory.domains.list().map((entry) => entry.name);
	if (named === undefined) {
		if (hosted.length === 0) {
			throw new ServerError(
				'NOT_FOUND',
				'no domain is hosted here; bumail domain add adds one',
			);
		}
		return hosted;
	}
	const domain = domainOf(named);
	if (domain === undefined) {
		throw new ServerError('INVALID', `"${named}" is not a domain name`);
	}
	if (!hosted.includes(domain)) {
		throw new ServerError(
			'NOT_FOUND',
			`the domain ${domain} is not hosted here; add it first`,
		);
	}
	return [domain];
}

/** A record `@bumail/auth` or `@bumail/dns` cannot write, as an error with a message; a damaged stored key is refused before, by `unusableKey`. */
function unwritable<T>(write: () => T): T {
	try {
		return write();
	} catch (error) {
		if (error instanceof AuthError || error instanceof DnsError) {
			throw new ServerError(
				'INVALID',
				`the DNS records cannot be written: ${error.message}`,
			);
		}
		throw error;
	}
}

/**
 * Runs `bumail dns`: prints the records every hosted domain (or the one
 * named) needs, as a zone file or as JSON, or with `--check` looks each
 * up in the DNS and reports it. Answers `ok`, or with `--check` `wrong`
 * (a record missing, different or doubled) or `unavailable` (only
 * because the DNS did not answer).
 */
export async function dnsCommand(
	args: DnsArgs,
	config: ServerConfig,
	{ out, resolver }: DnsIo,
): Promise<'ok' | 'wrong' | 'unavailable'> {
	const directory = Directory.open({
		file: directoryFile(config.directory.url),
	});
	let wanted: Plan;
	try {
		wanted = unwritable(() =>
			plan(config, directory, domainsOf(directory, args.domain), args),
		);
	} finally {
		directory.close();
	}
	if (!args.check) {
		out(
			unwritable(() => (args.json ? renderJson(wanted) : renderZone(wanted))),
		);
		return 'ok';
	}
	const checks = await check(
		wanted,
		resolver ?? nodeResolver({ timeout: TIMEOUT_MS, tries: TRIES }),
	);
	out(args.json ? renderJson(wanted, checks) : renderChecks(checks));
	return outcome(checks);
}
