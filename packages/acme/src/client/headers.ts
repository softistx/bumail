/** The longest `Retry-After` kept, in seconds: a week. */
export const MAX_RETRY_AFTER = 7 * 24 * 3600;
/** The longest nonce kept: Let's Encrypt's are about 30 characters. */
const MAX_NONCE_LENGTH = 512;

/** The `Replay-Nonce` of an answer, when it is one a JWS can carry. */
export function replayNonce(headers: Headers): string | undefined {
	const nonce = headers.get('replay-nonce');
	return nonce !== null &&
		nonce.length <= MAX_NONCE_LENGTH &&
		/^[A-Za-z0-9_-]+$/.test(nonce)
		? nonce
		: undefined;
}

/**
 * `Retry-After` (RFC 9110 §10.2.3) in seconds, from delay-seconds or an
 * HTTP date, clamped to 0 to a week; undefined when absent or unreadable.
 */
export function retryAfter(
	headers: Headers,
	now: number = Date.now(),
): number | undefined {
	const value = headers.get('retry-after')?.trim();
	if (!value) return undefined;
	let seconds: number;
	if (/^\d+$/.test(value)) {
		seconds = Number(value);
	} else {
		const at = Date.parse(value);
		if (Number.isNaN(at)) return undefined;
		seconds = Math.ceil((at - now) / 1000);
	}
	return Math.min(Math.max(seconds, 0), MAX_RETRY_AFTER);
}
