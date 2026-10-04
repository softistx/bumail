import type { Checker } from './checker';
import type { PortsConfig } from './types';

export const DEFAULT_PORTS: PortsConfig = {
	mx: 25,
	submissions: 465,
	submission: 587,
	imaps: 993,
	imap: 0,
	https: 443,
	http: 80,
	health: 8080,
};

const NAMES = Object.keys(DEFAULT_PORTS) as (keyof PortsConfig)[];

/**
 * `[ports]`: each an integer from 0 to 65535, 0 turning its listener off,
 * and no port given to two listeners. The health port is on loopback, but
 * a public listener bound to every address takes loopback too, so it is
 * checked with them.
 */
export function checkPorts(checker: Checker, raw: unknown): PortsConfig {
	const table = checker.table(raw, 'ports', NAMES);
	const ports = { ...DEFAULT_PORTS };
	const owner = new Map<number, string>();
	for (const name of NAMES) {
		ports[name] =
			checker.integer(table, name, 'ports', 0, 65535) ?? ports[name];
		const port = ports[name];
		if (port === 0) continue;
		const first = owner.get(port);
		if (first === undefined) {
			owner.set(port, name);
		} else {
			checker.add(`ports.${name}`, `${port} is also ports.${first}`);
		}
	}
	return ports;
}
