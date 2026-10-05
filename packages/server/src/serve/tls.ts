import { readFileSync } from 'node:fs';
import type { TlsConfig } from '../config/types';
import { ServerError } from '../errors';

/** The certificate chain and its key, PEM, as the listeners take them. */
export interface TlsFiles {
	readonly cert: string;
	readonly key: string;
}

/** `TlsConfig` for `tls.mode = "files"`. */
export type FilesTls = Extract<TlsConfig, { mode: 'files' }>;

/**
 * Reads `tls.cert` and `tls.key` at start, with `tls.mode = "files"`;
 * `watchTls` (`reload.ts`) reads them again for a renewed pair. A file
 * gone since the configuration was checked is `UNAVAILABLE`. Never repeats
 * the key.
 */
export function readTls(tls: FilesTls): TlsFiles {
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
