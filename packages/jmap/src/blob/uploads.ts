import { blobIdOf } from '@bumail/store';

/** A blob uploaded and not yet used, or used and kept until it expires. */
export interface Upload {
	readonly accountId: string;
	readonly blobId: string;
	readonly type: string;
	readonly bytes: Uint8Array;
	/** When it is forgotten, in ms since the epoch. */
	readonly expires: number;
}

/**
 * Uploads held in memory until they expire (RFC 8620 §6.1), at most
 * `quota` bytes per account. There is no blob store yet: a server that
 * restarts forgets them, and two servers do not share them.
 */
export class Uploads {
	readonly #ttl: number;
	readonly #quota: number;
	readonly #now: () => number;
	readonly #byAccount = new Map<string, Map<string, Upload>>();

	constructor(ttlSeconds: number, quota: number, now: () => number = Date.now) {
		this.#ttl = ttlSeconds * 1000;
		this.#quota = quota;
		this.#now = now;
	}

	/** Forgets every expired upload. */
	sweep(): void {
		const now = this.#now();
		for (const [accountId, uploads] of this.#byAccount) {
			for (const [blobId, upload] of uploads) {
				if (upload.expires <= now) uploads.delete(blobId);
			}
			if (uploads.size === 0) this.#byAccount.delete(accountId);
		}
	}

	/** Bytes the account holds. */
	held(accountId: string): number {
		let total = 0;
		for (const upload of this.#byAccount.get(accountId)?.values() ?? []) {
			total += upload.bytes.length;
		}
		return total;
	}

	/** Keeps an upload; `undefined` when it would take the account over its quota. */
	add(accountId: string, bytes: Uint8Array, type: string): Upload | undefined {
		this.sweep();
		const blobId = blobIdOf(bytes);
		const uploads = this.#byAccount.get(accountId) ?? new Map<string, Upload>();
		const same = uploads.get(blobId);
		const extra = same === undefined ? bytes.length : 0;
		if (this.held(accountId) + extra > this.#quota) return undefined;
		const upload: Upload = {
			accountId,
			blobId,
			type,
			bytes,
			expires: this.#now() + this.#ttl,
		};
		uploads.set(blobId, upload);
		this.#byAccount.set(accountId, uploads);
		return upload;
	}

	/** The account's upload with this id, if it has not expired. */
	get(accountId: string, blobId: string): Upload | undefined {
		const upload = this.#byAccount.get(accountId)?.get(blobId);
		if (upload === undefined) return undefined;
		if (upload.expires > this.#now()) return upload;
		this.#byAccount.get(accountId)?.delete(blobId);
		return undefined;
	}
}
