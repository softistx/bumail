import {
	bitString,
	ia5String,
	implicit,
	integer,
	nullValue,
	octetString,
	oid,
	sequence,
	set,
	utf8String,
} from '../der/write';
import { pem } from '../encoding';
import { AcmeError } from '../errors';
import { keyPairOf, SIGN_PARAMS } from '../keys/algorithm';
import { checkNames } from './names';
import { p1363ToDer } from './signature';

/** The object identifiers a request uses. */
export const OID = {
	commonName: '2.5.4.3',
	extensionRequest: '1.2.840.113549.1.9.14',
	subjectAltName: '2.5.29.17',
	ecdsaWithSha256: '1.2.840.10045.4.3.2',
	sha256WithRsaEncryption: '1.2.840.113549.1.1.11',
} as const;

/** ub-common-name (RFC 5280 Appendix A.1): a longer first name leaves the subject empty. */
const MAX_COMMON_NAME = 64;

/** Options of `createCsr`. */
export interface CsrOptions {
	/** The DNS names the certificate is for, the first one its subject's CN. At most 100. */
	names: readonly string[];
	/** The certificate's key pair: never the account's (RFC 8555 §11.1). ECDSA P-256 or RSA. */
	keyPair: CryptoKeyPair;
}

/** A certificate signing request. */
export interface Csr {
	/** The DER bytes: ACME's finalize sends them base64url as `csr` (RFC 8555 §7.4). */
	der: Uint8Array;
	/** The same as PEM, `-----BEGIN CERTIFICATE REQUEST-----`, for `openssl req` and the like. */
	pem: string;
	/** The names as the request holds them: checked, lowercased, in order. */
	names: string[];
}

/**
 * A PKCS #10 certificate request (RFC 2986) for DNS names, signed by the
 * key pair's private key: the subject `CN=<first name>` (empty when the
 * first name is longer than 64 characters), the public key as Web Crypto
 * exports it (SubjectPublicKeyInfo), and an `extensionRequest` attribute
 * holding a `subjectAltName` with every name as a `dNSName`. ECDSA P-256
 * signs with `ecdsa-with-SHA256`, its signature turned from P1363 into
 * DER; RSA with `sha256WithRSAEncryption`.
 */
export async function createCsr(options: CsrOptions): Promise<Csr> {
	if (typeof options !== 'object' || options === null) {
		throw new AcmeError(
			'INVALID_OPTION',
			'createCsr(): options must be an object',
		);
	}
	const names = checkNames(options.names);
	const { keyPair } = options;
	const alg = keyPairOf(keyPair, 'createCsr(): keyPair');
	const spki = new Uint8Array(
		await crypto.subtle.exportKey('spki', keyPair.publicKey),
	);
	const first = names[0] ?? '';
	const subject =
		first.length <= MAX_COMMON_NAME
			? sequence(set(sequence(oid(OID.commonName), utf8String(first))))
			: sequence();
	const subjectAltName = sequence(
		...names.map((name) => implicit(2, ia5String(name))),
	);
	const extensionRequest = sequence(
		oid(OID.extensionRequest),
		set(
			sequence(sequence(oid(OID.subjectAltName), octetString(subjectAltName))),
		),
	);
	const info = sequence(
		integer(0),
		subject,
		spki,
		implicit(0, set(extensionRequest)),
	);
	const raw = new Uint8Array(
		await crypto.subtle.sign(
			SIGN_PARAMS[alg],
			keyPair.privateKey,
			info as BufferSource,
		),
	);
	const algorithm =
		alg === 'ES256'
			? sequence(oid(OID.ecdsaWithSha256))
			: sequence(oid(OID.sha256WithRsaEncryption), nullValue());
	const signature = alg === 'ES256' ? p1363ToDer(raw) : raw;
	const der = sequence(info, algorithm, bitString(signature));
	return { der, pem: pem('CERTIFICATE REQUEST', der), names };
}
