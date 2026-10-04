import { isIP } from 'node:net';
import { addressOf } from '../directory/address';
import { invalidConfig } from '../errors';
import { checkCertificates } from './certificates';
import type { Checker, Table } from './checker';
import { checkRoutes, checkSmarthost } from './delivery';
import type { Env, Overrides } from './env';
import { checkHealth, checkJmap } from './jmap';
import { checkInbound, checkSubmission } from './limits';
import { isDomainName } from './names';
import { checkPorts } from './ports';
import { checkProxyProtocol } from './proxy-protocol';
import { checkStorage } from './storage';
import type { ServerConfig } from './types';

const SECTIONS = [
	'hostname',
	'postmaster',
	'data',
	'bind',
	'ports',
	'store',
	'queue',
	'directory',
	'tls',
	'acme',
	'smarthost',
	'routes',
	'inbound',
	'submission',
	'jmap',
	'health',
	'proxyProtocol',
];

export interface CheckContext {
	/** The file, as named in the error. */
	readonly file: string;
	/** Its directory, which relative paths start from. */
	readonly dir: string;
	readonly overrides: Overrides;
	readonly now: Date;
	/** The environment, for what Bun's clients read of it (`PGPASSWORD`). */
	readonly env: Env;
}

/**
 * A parsed configuration checked whole and given its defaults. Every
 * problem is collected before one `ServerError('INVALID_CONFIG')` is
 * thrown, recorded on top of the problems already in `checker` (the
 * environment's).
 */
export function checkConfig(
	checker: Checker,
	raw: Table,
	context: CheckContext,
): ServerConfig {
	const root = checker.table(raw, '', SECTIONS) ?? {};
	const { overrides } = context;

	const hostname = checkHostname(checker, root, overrides);
	const postmaster = checkPostmaster(checker, root);
	const data = checkData(checker, root);
	const bindValue = checker.string(root, 'bind', '');
	if (bindValue !== undefined && isIP(bindValue) === 0) {
		checker.add('bind', 'must be an IPv4 or IPv6 address');
	}
	const ports = checkPorts(checker, root['ports']);

	const { store, queue, directory } = checkStorage(checker, root, context);

	const { tls, acme } = checkCertificates(checker, root['tls'], root['acme'], {
		dir: context.dir,
		hostname,
		ports,
		now: context.now,
	});
	const smarthost = checkSmarthost(
		checker,
		root['smarthost'],
		context.dir,
		overrides,
	);
	const routes = checkRoutes(checker, root['routes'], smarthost);
	const inbound = checkInbound(checker, root['inbound']);
	const submission = checkSubmission(checker, root['submission']);
	const jmap = checkJmap(checker, root['jmap'], {
		hostname: hostname ?? '',
		ports,
		rawPorts: root['ports'],
		bind: bindValue ?? '0.0.0.0',
	});
	const health = checkHealth(checker, root['health']);
	const proxyProtocol = checkProxyProtocol(checker, root['proxyProtocol']);

	if (checker.problems.length > 0) {
		throw invalidConfig(context.file, checker.problems);
	}
	return {
		file: context.file,
		hostname: hostname ?? '',
		postmaster,
		data,
		bind: bindValue ?? '0.0.0.0',
		ports,
		store: store ?? { url: `sqlite:${data}/mail`, plaintext: false },
		queue: queue ?? { url: `sqlite:${data}/queue`, plaintext: false },
		directory: { url: directory?.url ?? `sqlite:${data}/directory.sqlite` },
		tls,
		acme,
		smarthost,
		routes,
		inbound,
		submission,
		jmap,
		health,
		proxyProtocol,
	};
}

/** `hostname`, lowercase, without a trailing dot; `BUMAIL_HOSTNAME` wins. */
function checkHostname(
	checker: Checker,
	root: Table,
	overrides: Overrides,
): string | undefined {
	const override = overrides.hostname;
	const path =
		override === undefined ? 'hostname' : `hostname (${override.from})`;
	const value = override?.value ?? checker.string(root, 'hostname', '');
	if (value === undefined) {
		if (root['hostname'] === undefined) {
			checker.add('hostname', 'is required (or set BUMAIL_HOSTNAME)');
		}
		return undefined;
	}
	const name = value.toLowerCase().replace(/\.$/, '');
	if (!isDomainName(name)) {
		checker.add(
			path,
			'must be a fully qualified domain name, such as mail.example.com',
		);
		return undefined;
	}
	return name;
}

/** `postmaster`, an address as the directory keeps it; whether it resolves is the server's question, at each message. */
function checkPostmaster(checker: Checker, root: Table): string | undefined {
	const value = checker.string(root, 'postmaster', '');
	if (value === undefined) return undefined;
	const parsed = addressOf(value);
	if (parsed === undefined) {
		checker.add(
			'postmaster',
			'must be an e-mail address, such as postmaster@example.com',
		);
		return undefined;
	}
	return parsed.address;
}

/** `data`, absolute, without a trailing slash. Default `/data`. */
function checkData(checker: Checker, root: Table): string {
	const value = checker.string(root, 'data', '');
	if (value === undefined) return '/data';
	if (!value.startsWith('/')) {
		checker.add('data', 'must be an absolute path');
		return '/data';
	}
	return value.length > 1 ? value.replace(/\/+$/, '') : value;
}
