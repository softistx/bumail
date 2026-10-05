import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fchmodSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TlsFiles } from '../tls';

const FLAGS =
	constants.O_CREAT |
	constants.O_EXCL |
	constants.O_WRONLY |
	constants.O_NOFOLLOW;

/**
 * What the ACME client keeps on the volume, in one directory (made 0700
 * when this creates it; one that exists is left as its owner set it):
 * `account.key`, the account's key; `key.pem` and `cert.pem`, the
 * certificate's key and chain; `key.prev.pem` and `cert.prev.pem`, the
 * pair before them. Each file is written whole to a temporary file of a
 * name no one can guess, created exclusively and never through a
 * symbolic link, mode 0600 and synced, then renamed over the old one; the
 * directory is synced after. A pair is written in this order: both new
 * files, then the old pair to the `.prev.` names, then both renames, so a
 * crash at any point leaves a complete pair under one of the two names.
 */
export class AcmeState {
	readonly dir: string;
	readonly #suffix: () => string;

	/** `suffix` makes the unique part of a temporary file's name; a spec gives its own. */
	constructor(dir: string, suffix: () => string = randomSuffix) {
		this.dir = dir;
		this.#suffix = suffix;
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

	writeAccountKey(pem: string): void {
		this.#write(join(this.dir, 'account.key'), pem);
	}

	/** The stored pair, or `undefined` when either file is missing. */
	readPair(): TlsFiles | undefined {
		return pairOf(this.certFile, this.keyFile);
	}

	/** The pair before the current one, or `undefined`. */
	readPrevious(): TlsFiles | undefined {
		return pairOf(this.#prev('cert.pem'), this.#prev('key.pem'));
	}

	/** Makes `pair` the current one, keeping the one it replaces as the previous. */
	writePair(pair: TlsFiles): void {
		const next = {
			key: this.#temporary(this.keyFile, pair.key),
			cert: this.#temporary(this.certFile, pair.cert),
		};
		const old = this.readPair();
		if (old !== undefined) this.#write(this.#prev('key.pem'), old.key);
		if (old !== undefined) this.#write(this.#prev('cert.pem'), old.cert);
		renameSync(next.key, this.keyFile);
		renameSync(next.cert, this.certFile);
		this.#syncDirectory();
	}

	/** Makes the previous pair the current one again, as it is. */
	restorePrevious(): void {
		const previous = this.readPrevious();
		if (previous === undefined) return;
		this.#write(this.keyFile, previous.key);
		this.#write(this.certFile, previous.cert);
	}

	#prev(name: string): string {
		return join(this.dir, name.replace(/\.pem$/, '.prev.pem'));
	}

	/** Writes `text` to a new temporary file beside `path`; answers its name. */
	#temporary(path: string, text: string): string {
		if (!existsSync(this.dir)) {
			mkdirSync(this.dir, { recursive: true, mode: 0o700 });
			chmodSync(this.dir, 0o700);
		}
		const temporary = `${path}.${this.#suffix()}.tmp`;
		const fd = openSync(temporary, FLAGS, 0o600);
		try {
			writeSync(fd, text);
			fchmodSync(fd, 0o600);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		return temporary;
	}

	#write(path: string, text: string): void {
		renameSync(this.#temporary(path, text), path);
		this.#syncDirectory();
	}

	#syncDirectory(): void {
		const fd = openSync(this.dir, constants.O_RDONLY);
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
	}
}

function randomSuffix(): string {
	return `${process.pid}.${crypto.randomUUID()}`;
}

function pairOf(certFile: string, keyFile: string): TlsFiles | undefined {
	const cert = read(certFile);
	const key = read(keyFile);
	return cert === undefined || key === undefined ? undefined : { cert, key };
}

function read(path: string): string | undefined {
	try {
		return readFileSync(path, 'utf8');
	} catch (error) {
		if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
		throw error;
	}
}
