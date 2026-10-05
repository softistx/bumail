import { isIP } from 'node:net';
import { type Options, refuseOptions, usage, word } from './verbs';

/** `bumail dns [<domain>] [--ip <address>] [--ip6 <address>] [--json] [--check]`. */
export type DnsArgs = {
	readonly kind: 'dns';
	/** The one domain asked for; `undefined`: every hosted domain. */
	readonly domain: string | undefined;
	/** The server's public IPv4 address, for its A record. */
	readonly ip: string | undefined;
	/** The server's public IPv6 address, for its AAAA record. */
	readonly ip6: string | undefined;
	readonly json: boolean;
	/** Query the DNS and report what is missing or differs. */
	readonly check: boolean;
	readonly config: string | undefined;
};

/** An address given to `--ip` or `--ip6`, checked as the version it names. */
function address(
	flag: string,
	version: 4 | 6,
	text: string | undefined,
): string | undefined {
	if (text === undefined) return undefined;
	if (isIP(text) !== version) {
		throw usage(`${flag} takes an IPv${version} address`);
	}
	return text;
}

/** `bumail dns …`, checked against what it takes. */
export function resolveDns(
	operands: readonly string[],
	options: Options,
): DnsArgs {
	if (operands.length > 1) {
		throw usage(`dns takes a domain at most, not ${word(operands[1] ?? '')}`);
	}
	refuseOptions('dns', options, { dns: true });
	return {
		kind: 'dns',
		domain: operands[0],
		ip: address('--ip', 4, options.ip),
		ip6: address('--ip6', 6, options.ip6),
		json: options.json,
		check: options.check,
		config: options.config,
	};
}
