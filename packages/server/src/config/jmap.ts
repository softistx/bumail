import { isIP } from 'node:net';
import type { Checker, Table } from './checker';
import { checkTrusted } from './trusted';
import type { HealthConfig, JmapConfig, PortsConfig } from './types';
import { checkHttpsUrl } from './urls';

/** An address a listener binds to, or the default; anything else is refused. */
function checkBind(
	checker: Checker,
	table: Table | undefined,
	path: string,
	fallback: string,
): string {
	const value = checker.string(table, 'bind', path);
	if (value === undefined) return fallback;
	if (isIP(value) === 0) {
		checker.add(`${path}.bind`, 'must be an IPv4 or IPv6 address');
		return fallback;
	}
	return value;
}

/**
 * `[jmap]`: `origin`, where clients reach it, an `https:` origin
 * (default `https://<hostname>`, with `ports.https` when it is not 443);
 * `mode`, `"https"` (default) or `"proxy"`; `bind`, an address (default
 * `bind`). With `"proxy"`, `origin` and `trusted` are required, and
 * `ports.https` must be set: the port the proxy reaches. `trusted` is
 * refused with `"https"`.
 */
export function checkJmap(
	checker: Checker,
	raw: unknown,
	context: {
		readonly hostname: string;
		readonly ports: PortsConfig;
		/** `[ports]` as written, to tell `https` set from its default. */
		readonly rawPorts: unknown;
		readonly bind: string;
	},
): JmapConfig {
	const table = checker.table(raw, 'jmap', [
		'origin',
		'mode',
		'bind',
		'trusted',
	]);
	const mode = checker.oneOf(table, 'mode', 'jmap', ['https', 'proxy']);
	const proxied = mode === 'proxy';
	const { ports } = context;
	const port =
		ports.https === 443 || ports.https === 0 ? '' : `:${ports.https}`;
	const fallback = `https://${context.hostname}${port}`;
	const value = checker.string(table, 'origin', 'jmap');
	if (proxied && table?.['origin'] === undefined) {
		checker.add(
			'jmap.origin',
			'is required with jmap.mode "proxy": the public URL clients reach, such as https://mail.example.com',
		);
	}
	const origin =
		value === undefined
			? fallback
			: (checkHttpsUrl(checker, value, 'jmap.origin', true) ?? fallback);
	if (proxied && ports.https !== 0) {
		const set = (context.rawPorts as Table | undefined)?.['https'];
		if (set === undefined) {
			checker.add(
				'ports.https',
				'is required with jmap.mode "proxy": the plain HTTP port the proxy reaches',
			);
		}
	}
	if (proxied && table?.['trusted'] === undefined) {
		checker.add(
			'jmap.trusted',
			'is required with jmap.mode "proxy": the addresses or CIDRs of the proxies',
		);
	}
	if (!proxied && table?.['trusted'] !== undefined) {
		checker.add('jmap.trusted', 'is only for jmap.mode "proxy"');
	}
	const trusted = checkTrusted(checker, table, 'trusted', 'jmap');
	return {
		origin,
		mode: mode ?? 'https',
		bind: checkBind(checker, table, 'jmap', context.bind),
		trusted: proxied ? trusted : [],
	};
}

/** `[health]`: `bind`, an address; default loopback, `127.0.0.1`. */
export function checkHealth(checker: Checker, raw: unknown): HealthConfig {
	const table = checker.table(raw, 'health', ['bind']);
	return { bind: checkBind(checker, table, 'health', '127.0.0.1') };
}
