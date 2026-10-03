import { Resolver as NodeDnsResolver } from 'node:dns/promises';

/**
 * The part of `node:dns/promises`' `Resolver` a `nodeResolver` calls. A
 * spec gives its own, so no spec ever queries the network.
 */
export interface DnsBackend {
	resolve4(
		name: string,
		options: { ttl: true },
	): Promise<{ address: string; ttl: number }[]>;
	resolve6(
		name: string,
		options: { ttl: true },
	): Promise<{ address: string; ttl: number }[]>;
	resolveMx(name: string): Promise<{ exchange: string; priority: number }[]>;
	resolveTxt(name: string): Promise<string[][]>;
	reverse(address: string): Promise<string[]>;
}

/** What a `nodeResolver` is built with. */
export interface NodeResolverOptions {
	/** DNS servers, as `node:dns` takes them (`'1.1.1.1'`, `'[::1]:53'`); the system's by default. */
	readonly servers?: readonly string[];
	/** Milliseconds before one try gives up; `node:dns`'s default (5000) when left out. */
	readonly timeout?: number;
	/** Tries per query before `TIMEOUT`; `node:dns`'s default (4) when left out. */
	readonly tries?: number;
	/**
	 * The TTL, in seconds, given to MX, TXT and PTR answers. `node:dns`
	 * reports a TTL for A and AAAA only, so for the other three this is what
	 * a cache keeps them for. 300 by default.
	 */
	readonly assumedTtl?: number;
	/** The resolver to query instead of `node:dns`'s: for specs, or a resolver of your own. */
	readonly backend?: DnsBackend;
}

/** A `node:dns/promises` `Resolver`, configured from the options. */
export function nodeBackend(options: NodeResolverOptions): DnsBackend {
	const resolver = new NodeDnsResolver({
		...(options.timeout === undefined ? {} : { timeout: options.timeout }),
		...(options.tries === undefined ? {} : { tries: options.tries }),
	});
	if (options.servers !== undefined) resolver.setServers([...options.servers]);
	return resolver;
}
