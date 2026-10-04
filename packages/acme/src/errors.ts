/**
 * Why a call was refused. Every one is about what the caller passed, and
 * none is worth retrying as is:
 *
 * - `INVALID_NAME`: a name for a certificate that is not a DNS name this
 *   package puts in a CSR;
 * - `INVALID_OPTION`: an option of the wrong type or out of range (no
 *   names, too many, a duplicate, a nonce or URL a JWS cannot carry);
 * - `INVALID_KEY`: a key of an algorithm this package does not sign with
 *   (ECDSA P-256 and RSASSA-PKCS1-v1_5 with SHA-256 only), one that cannot
 *   be used as asked, or a PEM that holds no such key;
 * - `INVALID_TOKEN`: a challenge token that is not base64url.
 */
export type AcmeErrorCode =
	| 'INVALID_NAME'
	| 'INVALID_OPTION'
	| 'INVALID_KEY'
	| 'INVALID_TOKEN';

/** Thrown by every function of the package, with the codes above. */
export class AcmeError extends Error {
	override readonly name = 'AcmeError';
	readonly code: AcmeErrorCode;

	/** `options.cause` keeps the error this one wraps, such as Web Crypto's own. */
	constructor(code: AcmeErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.code = code;
	}
}
