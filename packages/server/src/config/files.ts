import { readFileSync, statSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Checker } from './checker';

/** The largest file read: a configuration, a certificate chain, a key, a secret. */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * The text of `file`, or `undefined` with a problem recorded at `path`:
 * `cannot be read (<code>)`, or, checked before reading, `is not a
 * regular file` (a directory, a device, a FIFO that would never end) or
 * `is larger than 1 MiB`. A symbolic link is followed, as Kubernetes
 * mounts its secrets.
 */
export function readText(
	checker: Checker,
	file: string,
	path: string,
): string | undefined {
	try {
		const stat = statSync(file);
		if (!stat.isFile()) {
			checker.add(path, 'is not a regular file');
			return undefined;
		}
		if (stat.size > MAX_FILE_SIZE) {
			checker.add(path, 'is larger than 1 MiB');
			return undefined;
		}
		return readFileSync(file, 'utf8');
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		checker.add(
			path,
			`cannot be read (${typeof code === 'string' ? code : 'error'})`,
		);
		return undefined;
	}
}

/** `file` as given when absolute, else from `dir`: the configuration file's own directory. */
export function fromDir(dir: string, file: string): string {
	return isAbsolute(file) ? file : resolve(dir, file);
}
