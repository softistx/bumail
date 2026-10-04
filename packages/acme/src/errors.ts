import type { AcmeProblem } from './client/types';

/**
 * Why a call failed.
 *
 * About what the caller passed, none worth retrying as is:
 *
 * - `INVALID_NAME`: a name for a certificate that is not a DNS name this
 *   package puts in a CSR;
 * - `INVALID_OPTION`: an option of the wrong type or out of range (no
 *   names, too many, a duplicate, a nonce or URL a JWS cannot carry, a
 *   directory URL that is not `https:`);
 * - `INVALID_KEY`: a key of an algorithm this package does not sign with
 *   (ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 only), one that cannot
 *   be used as asked, or a PEM that holds no such key;
 * - `INVALID_TOKEN`: a challenge token that is not base64url;
 * - `NO_ACCOUNT`: a request that needs the account URL, made before
 *   `newAccount` or the `kid` option gave one.
 *
 * About the CA's answer, or the way to it:
 *
 * - `SERVER_PROBLEM`: the CA answered with an error: an
 *   `application/problem+json` document (RFC 7807) as `problem`, or only
 *   an error status as `status`;
 * - `RATE_LIMITED`: the CA refused with `urn:ietf:params:acme:error:rateLimited`;
 *   `retryAfter` holds its `Retry-After`, in seconds, when it gave one;
 * - `BAD_RESPONSE`: an answer this client cannot use: over its size cap,
 *   not JSON, a member missing or of the wrong type, a URL that is not
 *   `https:`, a redirect, no `Replay-Nonce` or `Location` where one is
 *   required, a certificate that is not a PEM chain;
 * - `NETWORK_ERROR`: `fetch` itself failed (DNS, refused, TLS);
 * - `TIMEOUT`: a request, a wait or `obtainCertificate` took longer than
 *   its time limit;
 * - `ABORTED`: the caller's `AbortSignal` fired;
 * - `AUTHORIZATION_FAILED`: an authorization ended other than `valid`, or
 *   offers no challenge this client answers; `problem` holds the
 *   challenge's error when the CA gave one;
 * - `ORDER_FAILED`: an order became `invalid`; `problem` holds its error.
 */
export type AcmeErrorCode =
	| 'INVALID_NAME'
	| 'INVALID_OPTION'
	| 'INVALID_KEY'
	| 'INVALID_TOKEN'
	| 'NO_ACCOUNT'
	| 'SERVER_PROBLEM'
	| 'RATE_LIMITED'
	| 'BAD_RESPONSE'
	| 'NETWORK_ERROR'
	| 'TIMEOUT'
	| 'ABORTED'
	| 'AUTHORIZATION_FAILED'
	| 'ORDER_FAILED';

/** What an `AcmeError` carries besides its code and message. */
export interface AcmeErrorOptions extends ErrorOptions {
	/** The CA's problem document, when it gave one. */
	problem?: AcmeProblem;
	/** The HTTP status of the answer the error is about. */
	status?: number;
	/** The CA's `Retry-After`, in seconds, clamped to a week. */
	retryAfter?: number;
}

/** Thrown by every function of the package, with the codes above. */
export class AcmeError extends Error {
	override readonly name = 'AcmeError';
	readonly code: AcmeErrorCode;
	/** The CA's problem document (RFC 7807), when the error is about one. */
	readonly problem?: AcmeProblem;
	/** The HTTP status of the CA's answer, when the error is about one. */
	readonly status?: number;
	/** Seconds the CA asked to wait (`Retry-After`), clamped to a week. */
	readonly retryAfter?: number;

	/** `options.cause` keeps the error this one wraps, such as Web Crypto's own. */
	constructor(
		code: AcmeErrorCode,
		message: string,
		options?: AcmeErrorOptions,
	) {
		super(message, options);
		this.code = code;
		if (options?.problem !== undefined) this.problem = options.problem;
		if (options?.status !== undefined) this.status = options.status;
		if (options?.retryAfter !== undefined) {
			this.retryAfter = options.retryAfter;
		}
	}
}
