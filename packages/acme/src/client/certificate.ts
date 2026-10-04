import { AcmeError } from '../errors';

/** One certificate or more, in PEM, nothing else. */
const PEM_CHAIN =
	/^(?:-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+\n-----END CERTIFICATE-----\n*)+$/;

/**
 * The PEM chain of a certificate download (RFC 8555 §7.4.2): UTF-8, one
 * `CERTIFICATE` block or more and nothing else, line ends made `\n`, or
 * `BAD_RESPONSE`.
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
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's answer is not a PEM certificate chain`,
			{ status },
		);
	}
	return `${chain}\n`;
}
