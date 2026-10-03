/**
 * Why a lookup gave no answer. The split that matters to SPF (RFC 7208
 * §2.6), DKIM (RFC 6376 §6.1.2) and DMARC (RFC 7489 §6.6.3) is between
 * `NOT_FOUND` — the DNS answered, and there is no such record: "none" or
 * "permerror" — and `TEMPORARY` or `TIMEOUT` — no answer was had:
 * "temperror", try again later. `INVALID_NAME` never left the machine,
 * and `INVALID_OPTION` is a resolver built with an option it cannot take.
 */
export type DnsErrorCode =
	| 'NOT_FOUND'
	| 'TEMPORARY'
	| 'TIMEOUT'
	| 'INVALID_NAME'
	| 'INVALID_OPTION';

/** Thrown by every resolver, whichever answers the interface, with the same codes. */
export class DnsError extends Error {
	override readonly name = 'DnsError';
	readonly code: DnsErrorCode;

	constructor(code: DnsErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Whether trying again later could give another answer: a `TEMPORARY` or
 * `TIMEOUT` error is, a `NOT_FOUND`, `INVALID_NAME` or `INVALID_OPTION` is
 * not, and anything
 * that is not a `DnsError` is treated as temporary.
 */
export function isTemporary(error: unknown): boolean {
	return (
		!(error instanceof DnsError) ||
		error.code === 'TEMPORARY' ||
		error.code === 'TIMEOUT'
	);
}
