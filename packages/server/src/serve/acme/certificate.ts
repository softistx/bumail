import { createPrivateKey, X509Certificate } from 'node:crypto';
import type { TlsFiles } from '../tls';

const DAY_MS = 86_400_000;

/** The first certificate of a PEM chain, or `undefined` when it holds none. */
export function leafOf(pem: string): X509Certificate | undefined {
	try {
		return new X509Certificate(pem);
	} catch {
		return undefined;
	}
}

/**
 * Why `pair` cannot serve `names` at `now`, or `undefined` when it can:
 * a certificate that parses, valid now, naming every name, and the key's
 * own. Never repeats the key.
 */
export function problemWith(
	pair: TlsFiles,
	names: readonly string[],
	now: Date,
): string | undefined {
	const certificate = leafOf(pair.cert);
	if (certificate === undefined) return 'the certificate is not a PEM chain';
	if (new Date(certificate.validFrom) > now) return 'not valid yet';
	if (new Date(certificate.validTo) <= now) return 'expired';
	const missing = names.filter(
		(name) => certificate.checkHost(name) === undefined,
	);
	if (missing.length > 0) return `it does not name ${missing.join(', ')}`;
	try {
		if (!certificate.checkPrivateKey(createPrivateKey(pair.key))) {
			return "the key is not the certificate's";
		}
	} catch {
		return 'the key is not an unencrypted PEM private key';
	}
	return undefined;
}

/**
 * When `certificate` is renewed: `days` before its end, or a third of its
 * lifetime before it when that is sooner, so a short-lived certificate is
 * not renewed in a loop.
 */
export function renewAt(certificate: X509Certificate, days: number): Date {
	const end = new Date(certificate.validTo).getTime();
	const lifetime = end - new Date(certificate.validFrom).getTime();
	return new Date(end - Math.min(days * DAY_MS, lifetime / 3));
}

/** A certificate for the log: its names and the day it ends. */
export function describeCertificate(certificate: X509Certificate): string {
	const names = (certificate.subjectAltName ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.map((entry) => entry.slice(4));
	const ends = new Date(certificate.validTo).toISOString().slice(0, 10);
	return `${names.join(', ')}; expires ${ends}`;
}
