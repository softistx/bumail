import { closeSync, fsyncSync, mkdirSync, openSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

/** A store's directories: its owner's alone, as mail is. */
export const PRIVATE_DIRECTORY = 0o700;
/** A store's files: its owner's alone, as mail is. */
export const PRIVATE_FILE = 0o600;

/** Flushes a directory, so an entry created, renamed or removed in it survives a crash. */
export async function syncDirectory(path: string): Promise<void> {
	const handle = await open(path, 'r');
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

/** `syncDirectory`, for opening, which is synchronous. */
export function syncDirectorySync(path: string): void {
	const fd = openSync(path, 'r');
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/**
 * Makes a private directory and whichever of its parents are missing, and
 * flushes the parent of each one it made, so none is lost to a crash.
 */
export function makeDirectory(path: string): void {
	const target = resolve(path);
	const made = mkdirSync(target, { recursive: true, mode: PRIVATE_DIRECTORY });
	if (made === undefined) return;
	const first = resolve(made);
	for (let at = target; dirname(at) !== at; at = dirname(at)) {
		syncDirectorySync(dirname(at));
		if (at === first) break;
	}
}
