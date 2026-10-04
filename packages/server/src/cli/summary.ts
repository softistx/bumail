import { isLoopback } from '../config/names';
import type { PortsConfig, ServerConfig } from '../config/types';

/**
 * A store's scheme, never its URL, which may hold a password; marked
 * `(plaintext)` when it sends its credentials in clear, as chosen.
 */
function schemeOf(store: { url: string; plaintext?: boolean }): string {
	const scheme = store.url.slice(0, store.url.indexOf(':'));
	return store.plaintext === true ? `${scheme} (plaintext)` : scheme;
}

function listeners(ports: PortsConfig, healthBind: string): string {
	const on = (Object.entries(ports) as [keyof PortsConfig, number][])
		.filter(([, port]) => port !== 0)
		.map(([name, port]) =>
			name === 'health'
				? `health ${port} (${isLoopback(healthBind) ? 'loopback' : healthBind})`
				: `${name} ${port}`,
		);
	return on.length > 0 ? on.join(', ') : 'none';
}

function outbound(config: ServerConfig): string {
	const { smarthost } = config;
	const route =
		smarthost === undefined
			? 'mx'
			: `smarthost ${smarthost.host}:${smarthost.port}`;
	const routes = Object.keys(config.routes).length;
	return routes === 0 ? route : `${route}, ${routes} route(s) by domain`;
}

function proxies(count: number): string {
	return `${count} trusted prox${count === 1 ? 'y' : 'ies'}`;
}

/** The origin, and behind a proxy, the plain HTTP address its proxies reach. */
function jmap({ jmap, ports }: ServerConfig): string {
	return jmap.mode === 'proxy'
		? `${jmap.origin} (behind ${proxies(jmap.trusted.length)}, plain HTTP on ${jmap.bind}:${ports.https})`
		: jmap.origin;
}

/**
 * What `check-config` prints once the configuration is valid: the file,
 * then what it sets. A store is named by its scheme alone, and no secret
 * appears.
 */
export function summary(config: ServerConfig): string {
	const rows: [string, string][] = [
		['hostname', config.hostname],
		['data', config.data],
		[
			'listening',
			`${config.bind}: ${listeners(config.ports, config.health.bind)}`,
		],
		['tls', config.tls.mode],
		['store', schemeOf(config.store)],
		['queue', schemeOf(config.queue)],
		['directory', schemeOf(config.directory)],
		['outbound', outbound(config)],
		['inbound dmarc', config.inbound.dmarc],
		['jmap', jmap(config)],
	];
	if (config.proxyProtocol !== undefined) {
		rows.push([
			'mail proxies',
			`${proxies(config.proxyProtocol.trusted.length)}, PROXY protocol`,
		]);
	}
	return [
		`${config.file}: ok`,
		...rows.map(([name, value]) => `  ${name.padEnd(14)}${value}`),
	].join('\n');
}
