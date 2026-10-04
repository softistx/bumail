/**
 * A problem document (RFC 7807) as an ACME server sends it (RFC 8555 §6.7):
 * its `type` is a URN such as `urn:ietf:params:acme:error:rateLimited`.
 * Read and bounded by the client: `detail` is cut to 1024 characters,
 * `subproblems` to 100.
 */
export interface AcmeProblem {
	type: string;
	detail?: string;
	/** The HTTP status the document names, when it is one (100 to 599). */
	status?: number;
	/** The identifier a subproblem is about (RFC 8555 §6.7.1). */
	identifier?: AcmeIdentifier;
	subproblems?: AcmeProblem[];
}

/** An identifier a certificate is for (RFC 8555 §9.7.7). This client orders `dns` ones. */
export interface AcmeIdentifier {
	type: string;
	value: string;
}

/** The directory (RFC 8555 §7.1.1): the URL of each resource, and the CA's `meta`. */
export interface AcmeDirectory {
	newNonce: string;
	newAccount: string;
	newOrder: string;
	revokeCert?: string;
	keyChange?: string;
	newAuthz?: string;
	/** Renewal information (RFC 9773), when the CA offers it. */
	renewalInfo?: string;
	meta?: AcmeDirectoryMeta;
}

/** The directory's `meta`, its members checked when present. */
export interface AcmeDirectoryMeta {
	/** The terms an account agrees to with `termsOfServiceAgreed`. */
	termsOfService?: string;
	website?: string;
	caaIdentities?: string[];
	externalAccountRequired?: boolean;
	/** The certificate profiles the CA offers, name to description. */
	profiles?: Record<string, string>;
}

/** The states of an order (RFC 8555 §7.1.6). */
export type AcmeOrderStatus =
	| 'pending'
	| 'ready'
	| 'processing'
	| 'valid'
	| 'invalid';

/** An order (RFC 8555 §7.1.3), with the URL it is fetched at. */
export interface AcmeOrder {
	/** The order's own URL: the `Location` of `newOrder`. */
	url: string;
	status: AcmeOrderStatus;
	identifiers: AcmeIdentifier[];
	/** One authorization URL per identifier. */
	authorizations: string[];
	/** Where the CSR is sent. */
	finalize: string;
	/** Where the chain is downloaded, once the order is `valid`. */
	certificate?: string;
	expires?: string;
	notBefore?: string;
	notAfter?: string;
	/** Why the order is `invalid`, when it is. */
	error?: AcmeProblem;
}

/** The states of an authorization (RFC 8555 §7.1.6). */
export type AcmeAuthorizationStatus =
	| 'pending'
	| 'valid'
	| 'invalid'
	| 'deactivated'
	| 'expired'
	| 'revoked';

/** An authorization (RFC 8555 §7.1.4), with the URL it is fetched at. */
export interface AcmeAuthorization {
	url: string;
	status: AcmeAuthorizationStatus;
	identifier: AcmeIdentifier;
	challenges: AcmeChallenge[];
	expires?: string;
	wildcard?: boolean;
}

/** The states of a challenge (RFC 8555 §7.1.6). */
export type AcmeChallengeStatus =
	| 'pending'
	| 'processing'
	| 'valid'
	| 'invalid';

/** A challenge (RFC 8555 §8), as an authorization lists it or `challenge()` answers. */
export interface AcmeChallenge {
	/** `http-01`, `dns-01`, `tls-alpn-01`, or another the CA offers. */
	type: string;
	url: string;
	status: AcmeChallengeStatus;
	/** The token, for `http-01` and `dns-01`. */
	token?: string;
	validated?: string;
	/** Why it is `invalid`, when it is. */
	error?: AcmeProblem;
}

/** What `fetch` the client calls: the global one, or one given for a test CA or a proxy. */
export type AcmeFetch = (input: string, init: RequestInit) => Promise<Response>;
