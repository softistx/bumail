import type { ProxyProtocolConfig } from '../config/types';

/**
 * The `proxyProtocol` option of `@bumail/smtp` and `@bumail/imap` for the
 * configured proxies, spread into a server's options: nothing when it is
 * off, so a listener reads no PROXY header at all.
 */
export function proxyOption(proxies: ProxyProtocolConfig | undefined): {
	readonly proxyProtocol?: { readonly trusted: readonly string[] };
} {
	return proxies === undefined
		? {}
		: { proxyProtocol: { trusted: proxies.trusted } };
}
