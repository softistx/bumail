import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Checker } from './checker';

/** The largest file read: a configuration, a certificate chain, a key, a secret. */
export const MAX_FILE_SIZE = 1024 * 1024;

/**
 * The text of `file`, or `undefined` with a problem recorded at `path`:
 * `cannot be read (<code>)`, `is not a regular file` (a directory, a
 * device, a FIFO that would never end) or `is larger than 1 MiB`. One
 * descriptor is opened, without blocking (a FIFO would wait for a
 * writer), checked with `fstat` and read, at most 1 MiB and a byte, so
 * the file checked is the file read. A symbolic link is followed, as
 * Kubernetes mounts its secrets.
 */
export function readText(
	checker: Checker,
	file: string,
	path: string,
): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
		const stat = fstatSync(fd);
		if (!stat.isFile()) {
			checker.add(path, 'is not a regular file');
			return undefined;
		}
		const buffer = Buffer.alloc(MAX_FILE_SIZE + 1);
		let length = 0;
		while (length < buffer.length) {
			const read = readSync(fd, buffer, length, buffer.length - length, null);
			if (read === 0) break;
			length += read;
		}
		if (length > MAX_FILE_SIZE) {
			checker.add(path, 'is larger than 1 MiB');
			return undefined;
		}
		return buffer.toString('utf8', 0, length);
	} catch (error) {
		const code = (error as { code?: unknown }).code;
		checker.add(
			path,
			`cannot be read (${typeof code === 'string' ? code : 'error'})`,
		);
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** `file` as given when absolute, else from `dir`: the configuration file's own directory. */
export function fromDir(dir: string, file: string): string {
	return isAbsolute(file) ? file : resolve(dir, file);
}
