import { BlockList, isIP } from 'node:net';

/** Whether an address is one of the trusted proxies. */
export type Trusts = (address: string) => boolean;

/**
 * Whether an address is in `entries`, IP addresses and CIDRs as
 * `config/trusted.ts` checked them. An IPv4-mapped IPv6 address
 * (`::ffff:10.0.0.5`, as a listener on `::` sees an IPv4 peer) matches
 * as its IPv4 address; anything that is not an IP address, a zone
 * included, is not trusted.
 */
export function trustsOf(entries: readonly string[]): Trusts {
	const list = new BlockList();
	for (const entry of entries) {
		const [address = '', prefix] = entry.split('/');
		const type = isIP(address) === 4 ? 'ipv4' : 'ipv6';
		if (prefix === undefined) list.addAddress(address, type);
		else list.addSubnet(address, Number(prefix), type);
	}
	return (address) => {
		const family = address.includes('%') ? 0 : isIP(address);
		return family !== 0 && list.check(address, family === 4 ? 'ipv4' : 'ipv6');
	};
}
