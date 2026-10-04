import { isIP } from 'node:net';

/** The 8 groups of an IPv6 address, as numbers; a dotted tail is its last two. */
function groups(ip: string): number[] {
	const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(ip);
	let text = ip;
	if (dotted !== null) {
		const [a, b, c, d] = dotted.slice(1).map(Number) as [
			number,
			number,
			number,
			number,
		];
		text = `${ip.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const [head = '', tail] = text.split('::');
	const left = head === '' ? [] : head.split(':');
	const right = tail === undefined || tail === '' ? [] : tail.split(':');
	const all =
		tail === undefined
			? left
			: [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
	return all.map((group) => Number.parseInt(group, 16));
}

/** The IPv4 address in the last 32 bits. */
function ipv4Of(g: readonly number[]): string {
	const [high = 0, low = 0] = g.slice(6);
	return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

/**
 * Which client an address counts as, for a limit per client: an IPv4
 * address as it is; an IPv6 address that embeds one — IPv4-mapped
 * (`::ffff:192.0.2.1`, in dotted or hex form, as a dual-stack listener
 * sees an IPv4 client) or NAT64 (`64:ff9b::/96`) — as that IPv4 address;
 * any other IPv6 address by its /64, which one machine usually holds
 * whole. Anything else — an empty string, a Unix socket — is `undefined`:
 * no client that can be told apart, so not limited, rather than putting
 * every such client in one bucket that one of them could fill for all.
 */
export function clientKey(ip: string | undefined): string | undefined {
	if (typeof ip !== 'string') return undefined;
	const address = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
	if (isIP(address) === 4) return address;
	if (isIP(address) !== 6) return undefined;
	const g = groups(address.toLowerCase());
	const prefix = g.slice(0, 6).join(':');
	if (prefix === '0:0:0:0:0:65535' || prefix === '100:65435:0:0:0:0') {
		return ipv4Of(g);
	}
	return `${g
		.slice(0, 4)
		.map((group) => group.toString(16))
		.join(':')}::/64`;
}
