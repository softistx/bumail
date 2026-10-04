import { isIP } from 'node:net';
import { invalidConfig } from '../errors';
import { checkCertificates } from './certificates';
import type { Checker, Table } from './checker';
import { checkRoutes, checkSmarthost } from './delivery';
import type { Overrides } from './env';
import { checkInbound, checkJmap, checkSubmission } from './limits';
import { isDomainName } from './names';
import { checkPorts } from './ports';
import type { ServerConfig } from './types';
import { checkStoreUrl } from './urls';

const SECTIONS = [
	'hostname',
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
];

export interface CheckContext {
	/** The file, as named in the error. */
	readonly file: string;
	/** Its directory, which relative paths start from. */
	readonly dir: string;
	readonly overrides: Overrides;
	readonly now: Date;
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
	const data = checkData(checker, root);
	const bindValue = checker.string(root, 'bind', '');
	if (bindValue !== undefined && isIP(bindValue) === 0) {
		checker.add('bind', 'must be an IPv4 or IPv6 address');
	}
	const ports = checkPorts(checker, root['ports']);

	const store = checkUrlSection(checker, root, 'store', overrides.storeUrl, [
		'sqlite',
		'postgres',
		'postgresql',
	]);
	const queue = checkUrlSection(checker, root, 'queue', overrides.queueUrl, [
		'sqlite',
		'postgres',
		'postgresql',
		'redis',
		'rediss',
	]);
	const directory = checkUrlSection(checker, root, 'directory', undefined, [
		'sqlite',
	]);

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
	const jmap = checkJmap(checker, root['jmap'], hostname ?? '', ports);

	if (checker.problems.length > 0) {
		throw invalidConfig(context.file, checker.problems);
	}
	return {
		file: context.file,
		hostname: hostname ?? '',
		data,
		bind: bindValue ?? '0.0.0.0',
		ports,
		store: { url: store ?? `sqlite:${data}/mail` },
		queue: { url: queue ?? `sqlite:${data}/queue` },
		directory: { url: directory ?? `sqlite:${data}/directory.sqlite` },
		tls,
		acme,
		smarthost,
		routes,
		inbound,
		submission,
		jmap,
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

/** `[store]`, `[queue]` or `[directory]`: a `url` alone, the environment's winning. */
function checkUrlSection(
	checker: Checker,
	root: Table,
	section: string,
	override: Overrides['storeUrl'],
	schemes: readonly string[],
): string | undefined {
	const table = checker.table(root[section], section, ['url']);
	const fromFile = checker.string(table, 'url', section);
	if (override !== undefined) {
		return checkStoreUrl(
			checker,
			override.value,
			`${section}.url (${override.from})`,
			schemes,
		);
	}
	if (fromFile === undefined) return undefined;
	return checkStoreUrl(checker, fromFile, `${section}.url`, schemes);
}
