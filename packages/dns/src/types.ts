/**
 * An MX record (RFC 5321 §5.1). `exchange` is lowercase with no trailing
 * dot; a null MX (RFC 7505, `0 .`) has an empty `exchange`, and
 * `isNullMx` says so.
 */
export interface MxRecord {
	readonly exchange: string;
	readonly priority: number;
	/** Seconds this answer may be kept. */
	readonly ttl: number;
}

/**
 * A TXT record, its character-strings joined with nothing between them,
 * as SPF (RFC 7208 §3.3), DKIM (RFC 6376 §3.6.2.2) and DMARC read it.
 */
export interface TxtRecord {
	readonly text: string;
	readonly ttl: number;
}

/** An A or AAAA record. */
export interface AddressRecord {
	readonly address: string;
	readonly ttl: number;
}

/** A PTR record: the name an address points back to, lowercase, no trailing dot. */
export interface PtrRecord {
	readonly name: string;
	readonly ttl: number;
}

/** The record types a resolver answers. */
export type RecordType = 'mx' | 'txt' | 'a' | 'aaaa' | 'ptr';

/**
 * The DNS a mail server needs, behind one small interface. Every method
 * normalises the name it is given (case, trailing dot, an IDN to its
 * A-labels), refuses one that cannot be a host name with `INVALID_NAME`
 * before any query, and either answers with at least one record or throws
 * a `DnsError`: `NOT_FOUND` when there is no such record, `TEMPORARY` or
 * `TIMEOUT` when no answer was had. Never an empty array.
 */
export interface Resolver {
	/** The MX records of a domain, lowest priority first. */
	mx(name: string): Promise<readonly MxRecord[]>;
	/** The TXT records at a name, in the order the DNS gave them. */
	txt(name: string): Promise<readonly TxtRecord[]>;
	/** The IPv4 addresses of a name. */
	a(name: string): Promise<readonly AddressRecord[]>;
	/** The IPv6 addresses of a name. */
	aaaa(name: string): Promise<readonly AddressRecord[]>;
	/** The names an IPv4 or IPv6 address points back to (its `in-addr.arpa` or `ip6.arpa` PTR records). */
	ptr(address: string): Promise<readonly PtrRecord[]>;
}
