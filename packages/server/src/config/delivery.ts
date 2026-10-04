import {
	type Checker,
	isRelayKey,
	isTable,
	keyPath,
	type Table,
} from './checker';
import type { Overrides } from './env';
import { fromDir, readText } from './files';
import { isDomainName, isHost } from './names';
import type { RouteConfig, SmarthostConfig } from './types';

const TLS_MODES = ['required', 'opportunistic', 'none'] as const;

/** A host to send to: `host`, `port`, `secure` and `tls`, as `[smarthost]` and a route take them. */
function checkHost(
	checker: Checker,
	table: Table,
	path: string,
	credentials: boolean,
): Omit<SmarthostConfig, 'username' | 'password'> {
	const hostValue = checker.string(table, 'host', path);
	if (hostValue === undefined && table['host'] === undefined) {
		checker.add(`${path}.host`, 'is required');
	} else if (hostValue !== undefined && !isHost(hostValue)) {
		checker.add(`${path}.host`, 'must be a host name or an IP address');
	}
	const portValue = checker.integer(table, 'port', path, 1, 65535);
	const secure = checker.boolean(table, 'secure', path) ?? portValue === 465;
	const port = portValue ?? (secure ? 465 : 587);
	const tls =
		checker.oneOf(table, 'tls', path, TLS_MODES) ??
		(credentials || secure ? 'required' : 'opportunistic');
	return { host: hostValue ?? '', port, secure, tls };
}

/**
 * `[smarthost]`, where every outbound message goes when it is given:
 * `password` or `passwordFile` (read here), never both, only with a
 * `username`; and credentials only over TLS — `secure`, or `tls =
 * "required"`. `BUMAIL_SMARTHOST_PASSWORD` wins over both.
 */
export function checkSmarthost(
	checker: Checker,
	raw: unknown,
	dir: string,
	overrides: Overrides,
): SmarthostConfig | undefined {
	const table = checker.table(raw, 'smarthost', [
		'host',
		'port',
		'secure',
		'tls',
		'username',
		'password',
		'passwordFile',
	]);
	if (table === undefined) {
		if (overrides.smarthostPassword !== undefined) {
			checker.add(
				overrides.smarthostPassword.from,
				'is set, but there is no [smarthost]',
			);
		}
		return undefined;
	}
	const username = checker.string(table, 'username', 'smarthost');
	const password = smarthostPassword(checker, table, dir, overrides);
	const hasPassword =
		password !== undefined ||
		table['password'] !== undefined ||
		table['passwordFile'] !== undefined;
	if (username !== undefined && !hasPassword) {
		checker.add('smarthost.username', 'needs a password or a passwordFile');
	}
	if (
		username === undefined &&
		hasPassword &&
		table['username'] === undefined
	) {
		checker.add(
			overrides.smarthostPassword?.from ?? 'smarthost.password',
			'needs a username',
		);
	}
	const host = checkHost(checker, table, 'smarthost', username !== undefined);
	if (username !== undefined && !host.secure && host.tls !== 'required') {
		checker.add(
			'smarthost.tls',
			'sends credentials without TLS; set tls = "required" or secure = true',
		);
	}
	return { ...host, username, password };
}

function smarthostPassword(
	checker: Checker,
	table: Table,
	dir: string,
	overrides: Overrides,
): string | undefined {
	const password = checker.string(table, 'password', 'smarthost');
	const passwordFile = checker.string(table, 'passwordFile', 'smarthost');
	if (overrides.smarthostPassword !== undefined) {
		return overrides.smarthostPassword.value;
	}
	if (table['password'] !== undefined && table['passwordFile'] !== undefined) {
		checker.add(
			'smarthost.password',
			'is given with passwordFile; give one of them',
		);
		return undefined;
	}
	if (passwordFile === undefined) return password;
	const text = readText(
		checker,
		fromDir(dir, passwordFile),
		'smarthost.passwordFile',
	);
	if (text === undefined) return undefined;
	const value = text.replace(/\r?\n$/, '');
	if (value === '') {
		checker.add('smarthost.passwordFile', 'names an empty file');
		return undefined;
	}
	return value;
}

/**
 * `[routes]`: a route per recipient domain, `"mx"`, `"smarthost"` (which
 * needs a `[smarthost]`) or a host of its own, never with credentials.
 */
export function checkRoutes(
	checker: Checker,
	raw: unknown,
	smarthost: SmarthostConfig | undefined,
): Record<string, RouteConfig> {
	// Its keys are domains, not options: each is checked below.
	const table = checker.table(raw, 'routes', undefined);
	const routes: Record<string, RouteConfig> = {};
	if (table === undefined) return routes;
	const seen = new Map<string, string>();
	for (const [key, value] of Object.entries(table)) {
		const path = keyPath('routes', key);
		if (isRelayKey(key)) {
			checker.unknown(path, key, []);
			continue;
		}
		const domain = key.toLowerCase().replace(/\.$/, '');
		if (!isDomainName(domain)) {
			checker.add(path, 'is not a domain name');
			continue;
		}
		const first = seen.get(domain);
		if (first !== undefined) {
			checker.add(path, `is the same domain as ${first}`);
			continue;
		}
		seen.set(domain, path);
		const route = checkRoute(checker, value, path, smarthost);
		if (route !== undefined) routes[domain] = route;
	}
	return routes;
}

function checkRoute(
	checker: Checker,
	value: unknown,
	path: string,
	smarthost: SmarthostConfig | undefined,
): RouteConfig | undefined {
	if (value === 'mx') return 'mx';
	if (value === 'smarthost') {
		if (smarthost === undefined) {
			checker.add(path, 'is "smarthost", but there is no [smarthost]');
			return undefined;
		}
		return 'smarthost';
	}
	if (!isTable(value)) {
		checker.add(path, 'must be "mx", "smarthost" or a table with a host');
		return undefined;
	}
	const table =
		checker.table(value, path, ['host', 'port', 'secure', 'tls']) ?? value;
	const host = checkHost(checker, table, path, false);
	return {
		host: host.host,
		port: host.port,
		secure: host.secure,
		tls: host.tls,
	};
}
