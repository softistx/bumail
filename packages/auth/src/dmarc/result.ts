import type { SpfResult } from '../spf/result';

/** RFC 7489 §11.2's results for the `dmarc` method of RFC 8601. */
export type DmarcResultWord =
	| 'pass'
	| 'fail'
	| 'none'
	| 'temperror'
	| 'permerror';

/** What a domain asks a receiver to do with mail that fails (`p=`, `sp=`). */
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';

/** One reporting address of `rua=` or `ruf=` (§6.2). */
export interface DmarcUri {
	/** The URI as written, such as `mailto:dmarc@example.com`. */
	readonly uri: string;
	/** The `!size` suffix in bytes (`!10m` is 10 485 760), when there is one. */
	readonly maxSize?: number;
}

/**
 * A DMARC record as read (§6.3). Every tag is there with its default when
 * the record leaves it out or writes it wrong, but `p` and `sp`, which are
 * absent then.
 */
export interface DmarcRecord {
	/** The policy for the domain, absent when missing or not one of the three. */
	readonly p?: DmarcPolicy;
	/** The policy for subdomains, absent when missing or not one of the three. */
	readonly sp?: DmarcPolicy;
	/** `sp=` is written but is not one of the three. */
	readonly invalidSp: boolean;
	/** DKIM alignment: `r` relaxed (the default) or `s` strict. */
	readonly adkim: 'r' | 's';
	/** SPF alignment: `r` relaxed (the default) or `s` strict. */
	readonly aspf: 'r' | 's';
	/** The percentage of failing mail the policy applies to, 0 to 100; 100 by default. */
	readonly pct: number;
	/** Where aggregate reports go; only the URIs that parse. */
	readonly rua: readonly DmarcUri[];
	/** Where failure reports go; only the URIs that parse. */
	readonly ruf: readonly DmarcUri[];
	/** Failure-reporting options, `['0']` by default. */
	readonly fo: readonly string[];
	/** Failure-report formats, `['afrf']` by default. */
	readonly rf: readonly string[];
	/** Seconds between aggregate reports, 86 400 by default. */
	readonly ri: number;
}

/** What `checkDmarc` came to, in RFC 8601's words. */
export interface DmarcResult {
	readonly result: DmarcResultWord;
	/** Why: what aligned, or what went wrong; listed in the troubleshooting page. */
	readonly reason: string;
	/** The RFC5322.From domain, lowercased, in A-labels; `''` when there is none to read. */
	readonly domain: string;
	/** Where the record was found: the From domain, or its organizational domain. */
	readonly policyDomain?: string;
	/** The policy that applies to `domain`: `sp` for a subdomain under its organizational domain's record, else `p`. `none` without a record. */
	readonly policy: DmarcPolicy;
	/**
	 * What to do with the message: `none` unless it fails. A failing
	 * message gets `policy` when sampled; when `pct` left it out, `reject`
	 * becomes `quarantine` and `quarantine` becomes `none` (§6.6.4). A
	 * message whose From cannot be evaluated gets `reject` (§6.6.1).
	 */
	readonly disposition: DmarcPolicy;
	/** The `d=` of the first passing DKIM signature aligned with `domain`. */
	readonly alignedDkim?: string;
	/** The SPF domain, when SPF passed for it and it is aligned with `domain`. */
	readonly alignedSpf?: string;
	/** Whether `pct` selected this message for the policy. */
	readonly sampled: boolean;
	/** The record that applied. */
	readonly record?: DmarcRecord;
}

/** An SPF result and the identity it was checked for. */
export interface SpfCheck {
	/** What `checkSpf` gave. */
	readonly result: SpfResult;
	/**
	 * `'mailfrom'` when `checkSpf` checked the MAIL FROM identity (its
	 * default, the HELO name standing in for a bounce), `'helo'` when it
	 * was given `identity: 'helo'`. DMARC aligns only the first (§3.1.2).
	 */
	readonly identity: 'mailfrom' | 'helo';
}
