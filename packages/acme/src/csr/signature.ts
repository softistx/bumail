import { integer, sequence } from '../der/write';

/**
 * An ECDSA signature as Web Crypto gives it — IEEE P1363, `r‖s`, each half
 * the curve's size — as the DER `ECDSA-Sig-Value ::= SEQUENCE { r INTEGER,
 * s INTEGER }` X.509 and PKCS #10 carry (RFC 3279 §2.2.3). `integer` trims
 * each half's leading zeros and puts one `0x00` back when the high bit is
 * set.
 */
export function p1363ToDer(signature: Uint8Array): Uint8Array {
	if (signature.length === 0 || signature.length % 2 !== 0) {
		throw new RangeError(
			`An ECDSA P1363 signature has two halves of one size, not ${signature.length} bytes`,
		);
	}
	const half = signature.length / 2;
	return sequence(
		integer(signature.subarray(0, half)),
		integer(signature.subarray(half)),
	);
}
