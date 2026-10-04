/**
 * A self-signed X.509 certificate (RFC 5280), for specs only: enough to
 * start a TLS listener on a key `exportPrivateKeyPem` wrote, and to show
 * the DER writer and the ECDSA conversion make something a TLS stack
 * verifies. Not shipped, and not an API.
 */

import { OID } from '../csr/csr';
import { p1363ToDer } from '../csr/signature';
import {
	bitString,
	element,
	explicit,
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

function utcTime(date: Date): Uint8Array {
	const text = date
		.toISOString()
		.replace(/[-:T]/g, '')
		.slice(2, 14)
		.concat('Z');
	return element(0x17, new TextEncoder().encode(text));
}

/** A certificate for `name`, valid from an hour ago for a day, signed by its own key. */
export async function selfSignedCertificate(
	keyPair: CryptoKeyPair,
	name: string,
): Promise<string> {
	return await issueCertificate({
		spki: new Uint8Array(
			await crypto.subtle.exportKey('spki', keyPair.publicKey),
		),
		names: [name],
		subject: name,
		issuer: name,
		signer: keyPair.privateKey,
	});
}

/** What `issueCertificate` writes. */
export interface IssueOptions {
	/** The subject's public key, as SubjectPublicKeyInfo DER. */
	spki: Uint8Array;
	/** The DNS names of its subjectAltName. */
	names: readonly string[];
	/** The CNs of the subject and the issuer. */
	subject: string;
	issuer: string;
	/** The issuer's private key, ECDSA P-256 or RSA. */
	signer: CryptoKey;
}

/** A certificate valid from an hour ago for a day: the subject's key and names, signed by the issuer. */
export async function issueCertificate(options: IssueOptions): Promise<string> {
	const { spki, names, subject, issuer, signer } = options;
	const ec = signer.algorithm.name === 'ECDSA';
	const algorithm = ec
		? sequence(oid(OID.ecdsaWithSha256))
		: sequence(oid(OID.sha256WithRsaEncryption), nullValue());
	const dn = (cn: string) =>
		sequence(set(sequence(oid(OID.commonName), utf8String(cn))));
	const now = Date.now();
	const tbs = sequence(
		explicit(0, integer(2)),
		integer(crypto.getRandomValues(new Uint8Array(16))),
		algorithm,
		dn(issuer),
		sequence(
			utcTime(new Date(now - 3_600_000)),
			utcTime(new Date(now + 86_400_000)),
		),
		dn(subject),
		spki,
		explicit(
			3,
			sequence(
				sequence(
					oid(OID.subjectAltName),
					octetString(
						sequence(...names.map((name) => implicit(2, ia5String(name)))),
					),
				),
			),
		),
	);
	const raw = new Uint8Array(
		await crypto.subtle.sign(
			ec ? { name: 'ECDSA', hash: 'SHA-256' } : { name: 'RSASSA-PKCS1-v1_5' },
			signer,
			tbs as BufferSource,
		),
	);
	const certificate = sequence(
		tbs,
		algorithm,
		bitString(ec ? p1363ToDer(raw) : raw),
	);
	return pem('CERTIFICATE', certificate);
}
