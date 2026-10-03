/**
 * Where one recipient stands. `pending`: not tried yet. `deferred`: a
 * temporary failure, tried again later. `delivered` and `failed` are
 * final.
 */
export type RecipientStatus = 'pending' | 'delivered' | 'deferred' | 'failed';

/** The final states: the queue never tries such a recipient again. */
export type FinalStatus = 'delivered' | 'failed';

/**
 * What the other side said, or why nobody said anything: the SMTP reply
 * (RFC 5321 §4.2) with its enhanced status code (RFC 3463), or, with no
 * `code`, the connection error or the timeout. The text is bounded and
 * holds no control character.
 */
export interface Diagnostic {
	/** The reply code; absent when no server answered. */
	readonly code?: number;
	/** The enhanced status code, `x.y.z`. */
	readonly status?: string;
	readonly text: string;
	/** The host that answered, or that the attempt was for. */
	readonly host?: string;
}

export interface RecipientState {
	/** `local@domain`, as enqueued. */
	readonly address: string;
	readonly status: RecipientStatus;
	/** The last answer for this recipient. */
	readonly reply?: Diagnostic;
	/** When the status last changed, in milliseconds since the epoch. */
	readonly updatedAt?: number;
}

/** Who is delivering an item, until when. */
export interface Lease {
	readonly owner: string;
	/** Milliseconds since the epoch; past it, another worker may claim the item. */
	readonly expiresAt: number;
}

/** A message in the queue, and where each of its recipients stands. */
export interface QueueItem {
	readonly id: string;
	/** The reverse-path; `''` for the null sender of a DSN. */
	readonly from: string;
	readonly recipients: readonly RecipientState[];
	/** The message's size in bytes. */
	readonly size: number;
	/** Milliseconds since the epoch. */
	readonly createdAt: number;
	/** When the item is due next, in milliseconds since the epoch. */
	readonly nextAttemptAt: number;
	/** How many attempts were made. */
	readonly attempts: number;
	/** The "delayed" DSN was sent for it. */
	readonly delayNotified: boolean;
	/** Present while a worker holds the item. */
	readonly lease?: Lease;
}

/** What `add` takes. */
export interface NewQueueItem {
	readonly from: string;
	/** One address or more, each once. */
	readonly to: readonly string[];
	/** The whole message, as it will be sent. */
	readonly message: Uint8Array;
	/** Milliseconds since the epoch; due at once. */
	readonly createdAt: number;
}

export interface AddOptions {
	/** Refuse with `QUEUE_FULL` when the store already holds this many items. */
	readonly maxItems?: number;
}

/** What `claim` takes: who claims, at what time, for how long. */
export interface ClaimRequest {
	readonly owner: string;
	/** Milliseconds since the epoch. */
	readonly now: number;
	/** How long the lease lasts, in milliseconds. */
	readonly leaseMs: number;
}

/** One recipient's outcome in an attempt. */
export interface RecipientUpdate {
	readonly address: string;
	readonly status: Exclude<RecipientStatus, 'pending'>;
	readonly reply?: Diagnostic;
}

/** What `complete` records: the attempt's outcomes, and when to try again. */
export interface AttemptResult {
	/** Milliseconds since the epoch: when the outcomes were known. */
	readonly now: number;
	/** The recipients this attempt reached; the others keep their state. */
	readonly recipients: readonly RecipientUpdate[];
	readonly nextAttemptAt: number;
	readonly attempts: number;
	readonly delayNotified: boolean;
}

export interface QueueListOptions {
	/** Default 0. */
	readonly offset?: number;
	/** Default 100. */
	readonly limit?: number;
}
