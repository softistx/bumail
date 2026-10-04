import { createPrivateKey, type KeyObject, X509Certificate } from 'node:crypto';
import type { Checker } from './checker';
import { readText } from './files';

const PEM_CERTIFICATE = '-----BEGIN CERTIFICATE-----';
const PEM_KEY = /-----BEGIN (?:RSA |EC )?PRIVATE KEY-----/;

/** The names a certificate is for: its DNS subject alternative names, else its CN. */
function namesOf(certificate: X509Certificate): string[] {
	const alt = (certificate.subjectAltName ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.map((entry) => entry.slice(4));
	if (alt.length > 0) return alt;
	const cn = /(?:^|\n)CN=([^\n]*)/.exec(certificate.subject ?? '')?.[1];
	return cn === undefined ? [] : [cn];
}

function certificateOf(
	checker: Checker,
	text: string,
	path: string,
): X509Certificate | undefined {
	if (text.includes(PEM_CERTIFICATE)) {
		try {
			return new X509Certificate(text);
		} catch {
			// Reported below, as for no PEM block at all.
		}
	}
	checker.add(path, 'is not a PEM certificate');
	return undefined;
}

function keyOf(
	checker: Checker,
	text: string,
	path: string,
): KeyObject | undefined {
	if (PEM_KEY.test(text)) {
		try {
			return createPrivateKey(text);
		} catch {
			// Reported below; the reason could quote the key.
		}
	}
	checker.add(path, 'is not an unencrypted PEM private key');
	return undefined;
}

/**
 * Checks `tls.cert` and `tls.key`: each readable and PEM, the certificate
 * (the first of the chain) valid at `now` and naming `hostname`, when it
 * is known, and the key its own. Never repeats the key.
 */
export function checkTlsFiles(
	checker: Checker,
	files: { readonly cert: string; readonly key: string },
	hostname: string | undefined,
	now: Date,
): void {
	const cert = readText(checker, files.cert, 'tls.cert');
	const key = readText(checker, files.key, 'tls.key');
	checkTlsPair(
		checker,
		{ cert: cert ?? '', key: key ?? '' },
		{ cert: cert !== undefined, key: key !== undefined },
		hostname,
		now,
	);
}

/**
 * `checkTlsFiles` on text already read: a pair a running server may take.
 * `read` says which of the two texts was read; the other has its problem
 * recorded already. Answers the certificate when it parsed.
 */
export function checkTlsPair(
	checker: Checker,
	text: { readonly cert: string; readonly key: string },
	read: { readonly cert: boolean; readonly key: boolean },
	hostname: string | undefined,
	now: Date,
): X509Certificate | undefined {
	const certificate = read.cert
		? certificateOf(checker, text.cert, 'tls.cert')
		: undefined;
	const key = read.key ? keyOf(checker, text.key, 'tls.key') : undefined;
	if (certificate === undefined) return undefined;
	const validFrom = new Date(certificate.validFrom);
	if (validFrom.getTime() > now.getTime()) {
		checker.add(
			'tls.cert',
			`is not valid until ${validFrom.toISOString().slice(0, 10)}`,
		);
	}
	const validTo = new Date(certificate.validTo);
	if (validTo.getTime() < now.getTime()) {
		checker.add('tls.cert', `expired on ${validTo.toISOString().slice(0, 10)}`);
	}
	if (hostname !== undefined && certificate.checkHost(hostname) === undefined) {
		const names = namesOf(certificate);
		checker.add(
			'tls.cert',
			`does not name ${hostname}` +
				(names.length > 0 ? ` (it names ${names.join(', ')})` : ''),
		);
	}
	if (key !== undefined && !matches(certificate, key)) {
		checker.add('tls.key', 'is not the key of tls.cert');
	}
	return certificate;
}

/** Whether `key` is the certificate's; a key of another type is not. */
function matches(certificate: X509Certificate, key: KeyObject): boolean {
	try {
		return certificate.checkPrivateKey(key);
	} catch {
		return false;
	}
}
