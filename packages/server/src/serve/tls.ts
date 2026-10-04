import { readFileSync } from 'node:fs';
import type { TlsConfig } from '../config/types';
import { ServerError } from '../errors';

/** The certificate chain and its key, PEM, as the listeners take them. */
export interface TlsFiles {
	readonly cert: string;
	readonly key: string;
}

/** What `serve` says of `tls.mode = "acme"`, which `check-config` still takes. */
export const ACME_LATER =
	'acme mode arrives in a later slice: set tls.mode = "files", with cert and key, for now';

/**
 * Reads `tls.cert` and `tls.key` at start; `watchTls` (`reload.ts`) reads
 * them again for a renewed pair. `tls.mode = "acme"` is `NOT_IMPLEMENTED`;
 * a file gone since the configuration was checked, `UNAVAILABLE`. Never
 * repeats the key.
 */
export function readTls(tls: TlsConfig): TlsFiles {
	if (tls.mode === 'acme') throw new ServerError('NOT_IMPLEMENTED', ACME_LATER);
	const read = (file: string, what: string) => {
		try {
			return readFileSync(file, 'utf8');
		} catch (error) {
			const code = (error as { code?: unknown }).code;
			throw new ServerError(
				'UNAVAILABLE',
				`tls.${what} ${file} cannot be read${typeof code === 'string' ? ` (${code})` : ''}`,
			);
		}
	};
	return { cert: read(tls.cert, 'cert'), key: read(tls.key, 'key') };
}
