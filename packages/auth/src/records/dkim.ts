import { decodeBase64Strict, encodeBase64, withoutFws } from '../dkim/tags';
import { AuthError } from '../errors';

/** What `dkimRecord` writes. */
export interface DkimRecordOptions {
	/**
	 * The public key: base64 (white space is dropped), or the bytes
	 * it is the base64 of. For RSA a SubjectPublicKeyInfo, for Ed25519 the
	 * 32 raw bytes (RFC 8463 §4). An empty string writes a revoked key,
	 * `v=DKIM1; p=`.
	 */
	readonly publicKey: string | Uint8Array;
	/** `'rsa'` (the default) or `'ed25519'`. */
	readonly keyType?: 'rsa' | 'ed25519';
	/** `t=y`: the domain is testing DKIM, and a failure should not count against it. */
	readonly testing?: boolean;
}

function refused(why: string): AuthError {
	return new AuthError('INVALID_OPTION', `dkimRecord(): ${why}`);
}

/** rsaEncryption, 1.2.840.113549.1.1.1, as the content of a DER OBJECT IDENTIFIER. */
const RSA_OID = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];

/** The content offset and length of the DER element at `at` with `tag`, or `undefined`. */
function element(
	bytes: Uint8Array,
	at: number,
	tag: number,
): { start: number; end: number } | undefined {
	if (bytes[at] !== tag) return undefined;
	let length = bytes[at + 1] ?? 0x80;
	let start = at + 2;
	if (length >= 0x80) {
		const count = length & 0x7f;
		if (count === 0 || count > 3) return undefined;
		length = 0;
		for (let i = 0; i < count; i++)
			length = length * 256 + (bytes[start + i] ?? 0);
		start += count;
	}
	return start + length <= bytes.length
		? { start, end: start + length }
		: undefined;
}

/** Whether the bytes are a SubjectPublicKeyInfo whose algorithm is rsaEncryption: a SEQUENCE holding a SEQUENCE that starts with that OID. */
function isRsaSpki(bytes: Uint8Array): boolean {
	const outer = element(bytes, 0, 0x30);
	const algorithm = outer && element(bytes, outer.start, 0x30);
	const oid = algorithm && element(bytes, algorithm.start, 0x06);
	return (
		oid !== undefined &&
		oid.end - oid.start === RSA_OID.length &&
		RSA_OID.every((byte, i) => bytes[oid.start + i] === byte)
	);
}

/**
 * A DKIM key record's text (RFC 6376 §3.6.1), to publish as a TXT record
 * at `<selector>._domainkey.<domain>`: `v=DKIM1; k=rsa; p=<base64>`, with
 * `t=y` after `k=` for a key in testing.
 *
 * ```ts
 * dkimRecord({ publicKey: spkiBase64 }); // 'v=DKIM1; k=rsa; p=MIIBIjAN…'
 * dkimRecord({ publicKey: raw32Bytes, keyType: 'ed25519' }); // 'v=DKIM1; k=ed25519; p=…'
 * dkimRecord({ publicKey: '' }); // 'v=DKIM1; p=' — the key is revoked
 * ```
 *
 * It throws `AuthError` `INVALID_OPTION` for a key that is not base64, an
 * Ed25519 key that is not 32 bytes, or an RSA key that is not a DER
 * SubjectPublicKeyInfo naming rsaEncryption. That is a structural check,
 * not an import: `verifyDkim` still gives `permerror` for one that is no key.
 */
export function dkimRecord(options: DkimRecordOptions): string {
	if (typeof options !== 'object' || options === null) {
		throw refused('options must be an object');
	}
	const type = options.keyType ?? 'rsa';
	if (type !== 'rsa' && type !== 'ed25519') {
		throw refused(`keyType must be 'rsa' or 'ed25519', not ${String(type)}`);
	}
	const { publicKey } = options;
	if (typeof publicKey !== 'string' && !(publicKey instanceof Uint8Array)) {
		throw refused('publicKey must be a base64 string or bytes');
	}
	const base64 =
		typeof publicKey === 'string'
			? withoutFws(publicKey)
			: encodeBase64(publicKey);
	const flags = options.testing === true ? '; t=y' : '';
	if (base64 === '') {
		if (options.testing === true || type !== 'rsa') {
			throw refused(
				'a revoked key (an empty publicKey) takes no keyType or testing',
			);
		}
		return 'v=DKIM1; p=';
	}
	const bytes = decodeBase64Strict(base64);
	if (bytes === undefined) throw refused('publicKey is not base64');
	if (type === 'ed25519' && bytes.length !== 32) {
		throw refused(`an ed25519 publicKey is 32 bytes, not ${bytes.length}`);
	}
	if (type === 'rsa' && !isRsaSpki(bytes)) {
		throw refused(
			'an rsa publicKey is a DER SubjectPublicKeyInfo naming rsaEncryption',
		);
	}
	return `v=DKIM1; k=${type}${flags}; p=${base64}`;
}
