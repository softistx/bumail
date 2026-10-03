/** RFC 7208 §2.6's results, as RFC 8601 §2.7.2 writes them. */
export type SpfResultWord =
	| 'none'
	| 'neutral'
	| 'pass'
	| 'fail'
	| 'softfail'
	| 'temperror'
	| 'permerror';

/** What `checkSpf` came to. */
export interface SpfResult {
	readonly result: SpfResultWord;
	/** Why: the mechanism that matched, or what went wrong; listed in the troubleshooting page. */
	readonly reason: string;
	/** The domain checked: the MAIL FROM domain, or the HELO name; lowercased, in A-labels when it could be read. */
	readonly domain: string;
	/** The term that decided, as written: `-all`, `include:_spf.example.com`, `ip4:192.0.2.0/24`. */
	readonly mechanism?: string;
	/** On `fail`, the domain's `exp=` text, macros expanded (§6.2); absent when it has none or it could not be had. */
	readonly explanation?: string;
	/** DNS-querying terms evaluated (include, a, mx, ptr, exists, redirect), of the 10 allowed. */
	readonly lookups: number;
}
