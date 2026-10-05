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
 * It throws `AuthError` `INVALID_OPTION` for a key that is not base64, or
 * an Ed25519 key that is not 32 bytes. It does not parse an RSA key's
 * structure; `verifyDkim` does, and gives `permerror` for one that is no key.
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
	return `v=DKIM1; k=${type}${flags}; p=${base64}`;
}
