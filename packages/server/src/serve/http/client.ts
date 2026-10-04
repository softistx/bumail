import { isIP } from 'node:net';
import type { Trusts } from './trusted';

/** Who a request is from, as the server decides, never as the request claims. */
export interface Client {
	/** The address the login limiter counts: the client's behind a trusted proxy, else the peer's. */
	readonly ip: string;
	/** Whether the request reached the client over TLS. */
	readonly secure: boolean;
}

/** `203.0.113.7`, `[2001:db8::1]` or `203.0.113.7:51000` as an IP address, or `undefined`. */
function addressOf(entry: string): string | undefined {
	const bare = /^\[([^\]]*)\](?::\d+)?$/.exec(entry)?.[1] ?? entry;
	if (isIP(bare) !== 0) return bare;
	const port = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(bare)?.[1];
	return port !== undefined && isIP(port) === 4 ? port : undefined;
}

/**
 * The client of a request that came in over plain HTTP from `peer`, the
 * TCP address, with `trusts` the proxies in front:
 *
 * - from a peer that is not trusted, `X-Forwarded-For` and
 *   `X-Forwarded-Proto` are ignored: the client is the peer, and the
 *   request is not secure;
 * - from a trusted peer, the client is the right-most `X-Forwarded-For`
 *   entry that is not itself a trusted proxy — what a client put on the
 *   left of the chain, spoofed or not, is never read past it — and the
 *   request is secure when the right-most `X-Forwarded-Proto` is `https`;
 * - with no such entry (none, only proxies, or one that is no IP address)
 *   the client is the peer.
 */
export function forwardedClient(
	peer: string,
	headers: Headers,
	trusts: Trusts,
): Client {
	if (!trusts(peer)) return { ip: peer, secure: false };
	const chain = (headers.get('x-forwarded-for') ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	let ip = peer;
	for (let i = chain.length - 1; i >= 0; i--) {
		const address = addressOf(chain[i] ?? '');
		if (address !== undefined && trusts(address)) continue;
		if (address !== undefined) ip = address;
		break;
	}
	const proto = (headers.get('x-forwarded-proto') ?? '')
		.split(',')
		.pop()
		?.trim()
		.toLowerCase();
	return { ip, secure: proto === 'https' };
}
