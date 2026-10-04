import { addressBytes } from './address';

/** One entry of `trusted`: a network, as its bytes and how many of its bits count. */
interface Network {
	readonly bytes: Uint8Array;
	readonly bits: number;
}

/** An entry as a network, or why it is not one. */
function networkOf(entry: unknown): Network | string {
	if (typeof entry !== 'string') return `${String(entry)} is not a string`;
	const [address = '', prefix, extra] = entry.split('/');
	const raw = addressBytes(address);
	if (!raw || extra !== undefined) {
		return `"${entry}" is neither an IP address nor a CIDR`;
	}
	// `::ffff:10.0.0.0/104` is `10.0.0.0/8`: the address became its IPv4 bytes.
	const mapped = raw.length === 4 && address.includes(':');
	const width = raw.length * 8;
	if (prefix === undefined) return { bytes: raw, bits: width };
	let bits = /^\d{1,3}$/.test(prefix) ? Number(prefix) : -1;
	if (mapped) bits -= 96;
	if (bits < 0 || bits > width) {
		return `"${entry}" has a prefix length out of range`;
	}
	if (bits === 0) {
		return `"${entry}" has a prefix length of 0, which trusts every peer`;
	}
	return { bytes: raw, bits };
}

function contains(network: Network, address: Uint8Array): boolean {
	if (network.bytes.length !== address.length) return false;
	const whole = network.bits >> 3;
	for (let at = 0; at < whole; at++) {
		if (network.bytes[at] !== address[at]) return false;
	}
	const rest = network.bits & 7;
	if (rest === 0) return true;
	const mask = (0xff << (8 - rest)) & 0xff;
	return (
		((network.bytes[whole] as number) & mask) ===
		((address[whole] as number) & mask)
	);
}

/**
 * `proxyProtocol.trusted` as a test of a peer's address: IPv4 and IPv6
 * addresses and CIDRs, an IPv4-mapped address or peer matched as its IPv4
 * address; a zone, or a prefix of 0, which trusts everyone, is refused. An entry that is neither throws, through `invalid`, and so
 * does an empty list: it would trust nobody, which is no proxy at all.
 */
export function trustedPeers(
	entries: unknown,
	invalid: (message: string) => Error,
): (peer: string) => boolean {
	if (!Array.isArray(entries) || entries.length === 0) {
		throw invalid(
			'proxyProtocol.trusted must list the addresses or CIDRs of the proxies, at least one',
		);
	}
	const networks = entries.map((entry: unknown) => {
		const network = networkOf(entry);
		if (typeof network === 'string') {
			throw invalid(`proxyProtocol.trusted: ${network}`);
		}
		return network;
	});
	return (peer) => {
		const address = addressBytes(peer);
		return (
			address !== undefined &&
			networks.some((network) => contains(network, address))
		);
	};
}
