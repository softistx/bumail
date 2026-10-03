import { DnsError, type DnsErrorCode } from '../errors';

/**
 * `node:dns`'s error codes by what they mean to a caller. `ENOTFOUND` and
 * `ENODATA` are both "no such record": Node keeps NXDOMAIN and NODATA
 * apart, but Bun reports both as `ENOTFOUND`, so a resolver on Bun cannot,
 * and none of SPF, DKIM, DMARC or the MX fallback needs it to.
 */
const CODES: Readonly<Record<string, DnsErrorCode>> = {
	ENOTFOUND: 'NOT_FOUND',
	ENODATA: 'NOT_FOUND',
	ETIMEOUT: 'TIMEOUT',
	EBADNAME: 'INVALID_NAME',
};

/** The `DnsError` for what `node:dns` threw; anything not known to mean otherwise is `TEMPORARY`. */
export function dnsErrorOf(error: unknown, query: string): DnsError {
	const code = (error as { code?: unknown } | null)?.code;
	const mapped = typeof code === 'string' ? CODES[code] : undefined;
	const why = typeof code === 'string' ? code : String(error);
	switch (mapped) {
		case 'NOT_FOUND':
			return new DnsError('NOT_FOUND', `No ${query} record (${why})`);
		case 'TIMEOUT':
			return new DnsError(
				'TIMEOUT',
				`The DNS did not answer ${query} in time (${why})`,
			);
		case 'INVALID_NAME':
			return new DnsError(
				'INVALID_NAME',
				`The DNS refused the name in ${query} (${why})`,
			);
		default:
			return new DnsError(
				'TEMPORARY',
				`The DNS could not answer ${query} (${why})`,
			);
	}
}
