import { X509Certificate } from 'node:crypto';
import { shown } from '../encoding';
import { AcmeError } from '../errors';

/** One certificate or more, in PEM, nothing else. */
const PEM_CHAIN =
	/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n*)+$/;
const PEM_BLOCK =
	/-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----/g;

function bad(where: string, message: string, status?: number): AcmeError {
	return new AcmeError(
		'BAD_RESPONSE',
		`${where}: ${message}`,
		status === undefined ? {} : { status },
	);
}

/**
 * The PEM chain of a certificate download (RFC 8555 §7.4.2), or
 * `BAD_RESPONSE`: UTF-8, one `CERTIFICATE` block or more and nothing else,
 * each an X.509 certificate, the leaf first and each one issued, and
 * signed, by the next. Line ends are made `\n`.
 */
export function pemChainOf(
	body: Uint8Array,
	status: number,
	where: string,
): string {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(body);
	} catch {
		text = '';
	}
	const chain = text.replace(/\r\n/g, '\n').trim();
	if (!PEM_CHAIN.test(chain)) {
		throw bad(where, "the CA's answer is not a PEM certificate chain", status);
	}
	const certificates = certificatesOf(chain, where, status);
	for (let i = 0; i + 1 < certificates.length; i++) {
		const subject = certificates[i] as X509Certificate;
		const issuer = certificates[i + 1] as X509Certificate;
		if (!subject.checkIssued(issuer) || !subject.verify(issuer.publicKey)) {
			throw bad(
				where,
				"the CA's chain is not in order, each certificate issued by the next",
				status,
			);
		}
	}
	return `${chain}\n`;
}

/** Each PEM block of a chain as an `X509Certificate`, or `BAD_RESPONSE`. */
function certificatesOf(
	chain: string,
	where: string,
	status?: number,
): X509Certificate[] {
	return (chain.match(PEM_BLOCK) ?? []).map((block) => {
		try {
			return new X509Certificate(block);
		} catch (error) {
			throw new AcmeError(
				'BAD_RESPONSE',
				`${where}: the CA's chain holds a block that is not an X.509 certificate`,
				{ cause: error, ...(status === undefined ? {} : { status }) },
			);
		}
	});
}

/**
 * Refuses, with `BAD_RESPONSE`, a chain whose leaf is not for `publicKey`,
 * has expired, or does not name exactly `names` as its DNS names, and
 * nothing else.
 */
export async function checkLeaf(
	chain: string,
	names: readonly string[],
	publicKey: CryptoKey,
	where: string,
): Promise<void> {
	const [leaf] = certificatesOf(chain, where);
	if (leaf === undefined) {
		throw bad(where, "the CA's answer is not a PEM certificate chain");
	}
	const expected = new Uint8Array(
		await crypto.subtle.exportKey('spki', publicKey),
	);
	const actual = new Uint8Array(
		leaf.publicKey.export({ type: 'spki', format: 'der' }),
	);
	if (Buffer.compare(expected, actual) !== 0) {
		throw bad(where, "the CA's certificate is not for certificateKey");
	}
	if (new Date(leaf.validTo).getTime() <= Date.now()) {
		throw bad(
			where,
			`the CA's certificate expired already, on ${shown(leaf.validTo)}`,
		);
	}
	const sans = (leaf.subjectAltName ?? '')
		.split(', ')
		.filter((entry) => entry !== '');
	const dns = sans
		.filter((entry) => entry.startsWith('DNS:'))
		.map((entry) => entry.slice(4).toLowerCase())
		.sort();
	const wanted = names.map((name) => name.toLowerCase()).sort();
	if (
		dns.length !== sans.length ||
		dns.length !== wanted.length ||
		dns.some((name, i) => name !== wanted[i])
	) {
		throw bad(
			where,
			`the CA's certificate names ${shown(sans.join(', '))}, not the names requested`,
		);
	}
}
