import { nodeResolver, type Resolver } from '@bumail/dns';
import type { ServerConfig } from '../../config/types';
import { domainOf } from '../../directory/address';
import { directoryFile } from '../../directory/database';
import { Directory } from '../../directory/directory';
import { ServerError } from '../../errors';
import type { DnsArgs } from '../dns-args';
import { allThere, check, renderChecks } from './check';
import { plan } from './plan';
import { renderJson, renderZone } from './render';

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

/**
 * Runs `bumail dns`: prints the records every hosted domain (or the one
 * named) needs, as a zone file or as JSON, or with `--check` looks each
 * up in the DNS and reports it. Answers `false` only when
 * `--check` finds a record missing, different, or not answered for.
 */
export async function dnsCommand(
	args: DnsArgs,
	config: ServerConfig,
	{ out, resolver }: DnsIo,
): Promise<boolean> {
	const directory = Directory.open({
		file: directoryFile(config.directory.url),
	});
	let wanted: ReturnType<typeof plan>;
	try {
		wanted = plan(config, directory, domainsOf(directory, args.domain), args);
	} finally {
		directory.close();
	}
	if (!args.check) {
		out(args.json ? renderJson(wanted) : renderZone(wanted));
		return true;
	}
	const checks = await check(
		wanted,
		resolver ?? nodeResolver({ timeout: TIMEOUT_MS, tries: TRIES }),
	);
	out(args.json ? renderJson(wanted, checks) : renderChecks(checks));
	return allThere(checks);
}
