import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { type FileHandle, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readChunks } from '../contract/blob';
import type { Content } from '../contract/types';
import {
	makeDirectory,
	PRIVATE_DIRECTORY,
	PRIVATE_FILE,
	syncDirectory,
	syncDirectorySync,
} from './disk';

const STAGING = '.staging';
const BLOB_ID = /^[0-9a-f]{64}$/;

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

/**
 * The blobs of a store, one file per content under `blobs/`, named by its
 * SHA-256 in hex and spread over 256 directories by its first two digits.
 * Content is written to a `.staging` file, flushed, renamed into place and
 * its directory flushed, so a blob that has a name is whole; the same
 * bytes are written once. Which account uses which blob is the database's
 * business, not this one's.
 */
export class BlobFiles {
	readonly directory: string;

	/** The blobs under `directory`, created if need be; staging files a crash left are removed. */
	constructor(directory: string) {
		this.directory = directory;
		makeDirectory(directory);
		for (const name of readdirSync(directory)) {
			if (name.endsWith(STAGING)) rmSync(join(directory, name));
		}
		// What a crash left half-flushed is flushed now: the sweep, a shard
		// made by a process that died before it flushed it, and `blobs/` itself.
		syncDirectorySync(directory);
		syncDirectorySync(dirname(directory));
	}

	/** Where a blob lives, or `undefined` for a string that is no blob id. */
	pathOf(blobId: string): string | undefined {
		if (typeof blobId !== 'string' || !BLOB_ID.test(blobId)) return undefined;
		return join(this.directory, blobId.slice(0, 2), blobId);
	}

	/**
	 * Writes content to its blob, read as `readChunks` reads it: a stream that
	 * fails is `INVALID`, and a disk that fails throws its own error. Either
	 * way nothing is left behind.
	 */
	async write(content: Content): Promise<{ blobId: string; size: number }> {
		const staging = join(this.directory, `${crypto.randomUUID()}${STAGING}`);
		const handle = await open(staging, 'wx', PRIVATE_FILE);
		let read: { blobId: string; size: number };
		try {
			read = await readChunks(content, (chunk) => writeAll(handle, chunk));
			await handle.sync();
		} catch (error) {
			await handle.close().catch(() => undefined);
			await unlink(staging).catch(() => undefined);
			throw error;
		}
		await handle.close();
		await this.#place(staging, read.blobId);
		return read;
	}

	/** Moves a staged blob to its name, or drops it when that name is taken. */
	async #place(staging: string, blobId: string): Promise<void> {
		const target = this.pathOf(blobId) as string;
		if (await exists(target)) {
			await unlink(staging);
			return;
		}
		const shard = join(this.directory, blobId.slice(0, 2));
		const newShard = !(await exists(shard));
		if (newShard)
			mkdirSync(shard, { recursive: true, mode: PRIVATE_DIRECTORY });
		try {
			await rename(staging, target);
		} catch (error) {
			await unlink(staging).catch(() => undefined);
			throw error;
		}
		await syncDirectory(shard);
		if (newShard) await syncDirectory(this.directory);
	}

	/** The blob as a lazy file, or `undefined` when there is none by that id. */
	async file(blobId: string): Promise<Blob | undefined> {
		const path = this.pathOf(blobId);
		if (path === undefined || !(await exists(path))) return undefined;
		return Bun.file(path);
	}

	/** Removes a blob no message uses any more; one already gone is fine. */
	async remove(blobId: string): Promise<void> {
		const path = this.pathOf(blobId);
		if (path === undefined) return;
		try {
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
		}
	}
}

/** Writes a whole chunk: a file handle may write less than it is given. */
async function writeAll(handle: FileHandle, chunk: Uint8Array): Promise<void> {
	for (let offset = 0; offset < chunk.length; ) {
		const { bytesWritten } = await handle.write(
			chunk,
			offset,
			chunk.length - offset,
		);
		offset += bytesWritten;
	}
}
