import type { X509Certificate } from 'node:crypto';

/**
 * How a certificate is named in the log: its subject on one line, or,
 * when it has none — Let's Encrypt's certificates have an empty subject
 * — its DNS names.
 */
export function subjectOf(certificate: X509Certificate): string {
	const subject = certificate.subject as string | undefined;
	if (subject !== undefined && subject !== '') {
		return subject.split('\n').join(', ');
	}
	return (certificate.subjectAltName ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.join(', ');
}

/** A problem's text with `tls.cert` and `tls.key` replaced by what the files are called here. */
export function relabel(
	reason: string,
	labels: { readonly cert: string; readonly key: string } | undefined,
): string {
	if (labels === undefined) return reason;
	return reason
		.split('tls.cert')
		.join(labels.cert)
		.split('tls.key')
		.join(labels.key);
}
