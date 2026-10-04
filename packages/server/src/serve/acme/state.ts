import { chmodSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { TlsFiles } from '../tls';

/**
 * What the ACME client keeps on the volume, in one directory of mode
 * 0700: `account.key`, the account's key; `key.pem` and `cert.pem`, the
 * certificate's key and its chain. Each is written to a file of its own
 * name plus `.tmp`, mode 0600, then renamed over the old one, so a
 * reader sees the old content or the new, never half.
 */
export class AcmeState {
	readonly dir: string;

	constructor(dir: string) {
		this.dir = dir;
	}

	get certFile(): string {
		return join(this.dir, 'cert.pem');
	}

	get keyFile(): string {
		return join(this.dir, 'key.pem');
	}

	/** The account key's PEM, or `undefined` before the first start. */
	readAccountKey(): string | undefined {
		return read(join(this.dir, 'account.key'));
	}

	async writeAccountKey(pem: string): Promise<void> {
		await this.#write(join(this.dir, 'account.key'), pem);
	}

	/** The stored pair, or `undefined` when either file is missing. */
	readPair(): TlsFiles | undefined {
		const cert = read(this.certFile);
		const key = read(this.keyFile);
		return cert === undefined || key === undefined ? undefined : { cert, key };
	}

	/** Writes the key, then the certificate, each atomically. */
	async writePair(pair: TlsFiles): Promise<void> {
		await this.#write(this.keyFile, pair.key);
		await this.#write(this.certFile, pair.cert);
	}

	async #write(path: string, text: string): Promise<void> {
		mkdirSync(this.dir, { recursive: true, mode: 0o700 });
		chmodSync(this.dir, 0o700);
		const temporary = `${path}.tmp`;
		const file = await open(temporary, 'w', 0o600);
		try {
			await file.writeFile(text);
			await file.chmod(0o600);
			await file.sync();
		} finally {
			await file.close();
		}
		renameSync(temporary, path);
	}
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
		throw error;
	}
}
