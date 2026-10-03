/** RFC 8601 §2.7.1's words for a DKIM result. */
export type DkimResultWord =
	| 'pass'
	| 'fail'
	| 'neutral'
	| 'temperror'
	| 'permerror'
	| 'policy'
	| 'none';

/** The signing algorithms verified and signed with. */
export type DkimAlgorithm = 'rsa-sha256' | 'ed25519-sha256';

/**
 * What one DKIM-Signature came to. Every field but `result` and `testing`
 * is there as far as the signature could be read: a signature whose tags
 * do not parse has none of them.
 */
export interface DkimResult {
	readonly result: DkimResultWord;
	/** Why, for every result but `pass`; listed in the troubleshooting page. */
	readonly reason?: string;
	/** `d=`, the signing domain, lowercased. */
	readonly domain?: string;
	/** `s=`, the selector. */
	readonly selector?: string;
	/** `i=`, the agent or user identifier; `@` and `d=` when the signature has none. */
	readonly identity?: string;
	/** `a=` as written. */
	readonly algorithm?: string;
	/** `b=` without its white space: RFC 8601's `header.b` takes a prefix of it. */
	readonly signature?: string;
	/** `h=`, lowercased, in order. */
	readonly signedHeaders?: readonly string[];
	/**
	 * `l=`, when the signature has one: only that many octets of the
	 * canonical body are signed, and anything after them could have been
	 * added by anyone (RFC 6376 §8.2).
	 */
	readonly bodyLength?: number;
	/** Octets of the canonical body past `l=`, unsigned, once the body was hashed. */
	readonly unsignedBodyLength?: number;
	/** `t=`, seconds since the epoch. */
	readonly timestamp?: number;
	/** `x=`, seconds since the epoch. */
	readonly expires?: number;
	/** The key record says `t=y`: the domain is testing DKIM, and asks that a failure be treated like no signature. */
	readonly testing: boolean;
}

/** A result that ends a signature's check: everything but the word and the reason is filled in later. */
export interface Verdict {
	readonly result: Exclude<DkimResultWord, 'pass' | 'none'>;
	readonly reason: string;
}

export function verdict(result: Verdict['result'], reason: string): Verdict {
	return { result, reason };
}
