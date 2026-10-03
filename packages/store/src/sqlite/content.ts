import type { Content } from '../contract/types';
import type { BlobFiles } from './blobs';

/**
 * The blob files as the store uses them, so that no row ever names a blob
 * that is not on disk:
 *
 * - content is written and flushed **before** the row naming it commits,
 *   and held as pending until that commit is over, so the blob of a message
 *   being added is never collected under it;
 * - a blob no account holds any more is removed only under its id's lock,
 *   which placing the same bytes also takes, and only when no account holds
 *   it and no add is pending on it: a removal never races a write that
 *   finds the blob already there and keeps it.
 *
 * One process opens a store, so a lock in memory serializes them all.
 */
export class BlobKeeper {
	readonly files: BlobFiles;
	readonly #held: (blobId: string) => boolean;
	readonly #pending = new Map<string, number>();
	readonly #locks = new Map<string, Promise<void>>();

	/** `held` says whether any account holds the blob, as the database says. */
	constructor(files: BlobFiles, held: (blobId: string) => boolean) {
		this.files = files;
		this.#held = held;
	}

	/**
	 * Writes content to its blob, flushed, and holds it pending: the caller
	 * commits the row that names it, then calls `settle` whatever happened.
	 */
	async write(content: Content): Promise<{ blobId: string; size: number }> {
		const staged = await this.files.stage(content);
		await this.#exclusive(staged.blobId, async () => {
			this.#pending.set(
				staged.blobId,
				(this.#pending.get(staged.blobId) ?? 0) + 1,
			);
			try {
				await this.files.place(staged);
			} catch (error) {
				this.#unpend(staged.blobId);
				throw error;
			}
		});
		return { blobId: staged.blobId, size: staged.size };
	}

	/** The add that wrote this blob is over: committed, or not. */
	settle(blobId: string): void {
		this.#unpend(blobId);
	}

	/**
	 * Removes each blob no account holds and no add is waiting on. A failure
	 * leaves the file behind, which is harmless: a blob nothing names.
	 */
	async collect(blobIds: Iterable<string>): Promise<void> {
		for (const blobId of new Set(blobIds)) {
			await this.#exclusive(blobId, async () => {
				if (this.#pending.has(blobId) || this.#held(blobId)) return;
				await this.files.remove(blobId);
			}).catch(() => undefined);
		}
	}

	#unpend(blobId: string): void {
		const count = (this.#pending.get(blobId) ?? 1) - 1;
		if (count > 0) this.#pending.set(blobId, count);
		else this.#pending.delete(blobId);
	}

	/** Runs `fn` alone among the callers that name this blob. */
	async #exclusive(blobId: string, fn: () => Promise<void>): Promise<void> {
		const prior = this.#locks.get(blobId) ?? Promise.resolve();
		let release = () => {};
		const mine = new Promise<void>((resolve) => {
			release = resolve;
		});
		const tail = prior.then(() => mine);
		this.#locks.set(blobId, tail);
		await prior;
		try {
			await fn();
		} finally {
			release();
			if (this.#locks.get(blobId) === tail) this.#locks.delete(blobId);
		}
	}
}
