import { trustedPeers } from '../../proxy/trusted';

/** Whether an address is one of the trusted proxies. */
export type Trusts = (address: string) => boolean;

/**
 * Whether an address is in `entries`, by the rules `@bumail/smtp` and
 * `@bumail/imap` apply to `proxyProtocol.trusted` (`src/proxy/`, a copy
 * of theirs): an IPv4-mapped address matches as its IPv4 address, and
 * a network of one family never matches the other. The entries are
 * those `config/trusted.ts` accepted; one it did not throws.
 */
export function trustsOf(entries: readonly string[]): Trusts {
	if (entries.length === 0) return () => false;
	return trustedPeers(entries, (message) => new Error(message));
}
