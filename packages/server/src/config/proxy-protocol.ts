import type { Checker } from './checker';
import { checkTrusted } from './trusted';
import type { ProxyProtocolConfig } from './types';

/** The top-level `[proxyProtocol]`: `trusted`, required when the table is there. Absent: off. */
export function checkProxyProtocol(
	checker: Checker,
	raw: unknown,
): ProxyProtocolConfig | undefined {
	const table = checker.table(raw, 'proxyProtocol', ['trusted']);
	if (table === undefined) return undefined;
	if (table['trusted'] === undefined) {
		checker.add(
			'proxyProtocol.trusted',
			'is required: the addresses or CIDRs of the proxies, or remove [proxyProtocol] to turn it off',
		);
		return undefined;
	}
	const trusted = checkTrusted(checker, table, 'trusted', 'proxyProtocol');
	return trusted.length === 0 ? undefined : { trusted };
}
