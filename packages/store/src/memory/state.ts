import type { Account, Mailbox, MailboxRole, Message } from '../contract/types';
import { StoreError } from '../errors';

export interface MailboxState {
	id: string;
	accountId: string;
	name: string;
	parentId?: string;
	role?: MailboxRole;
	uidValidity: number;
	uidNext: number;
	createdModseq: number;
	/** The last change to the mailbox itself: created, renamed, moved. */
	modseq: number;
	highestModseq: number;
}

export interface MessageState {
	id: string;
	accountId: string;
	blobId: string;
	size: number;
	flags: string[];
	receivedAt: number;
	createdModseq: number;
	modseq: number;
	mailboxes: Map<string, { uid: number; modseq: number }>;
}

export type Tombstone =
	| {
			kind: 'expunged';
			modseq: number;
			messageId: string;
			mailboxId: string;
			uid: number;
	  }
	| {
			kind: 'message' | 'mailbox';
			modseq: number;
			id: string;
			createdModseq: number;
	  };

export interface AccountState {
	account: Account;
	modseq: number;
	/** The oldest `since` still answered: tombstones before it were pruned. */
	floor: number;
	tombstones: Tombstone[];
}

/** RFC 9051 §2.3.1.1: a UID is a 32-bit number. */
export const MAX_UID = 2 ** 32 - 1;
const SEEN = '\\Seen';

/** The memory store's data, and the lookups and bookkeeping its operations share. */
export class MemoryState {
	readonly accounts = new Map<string, AccountState>();
	readonly mailboxes = new Map<string, MailboxState>();
	readonly messages = new Map<string, MessageState>();
	readonly blobs = new Map<string, { bytes: Uint8Array; uses: number }>();
	readonly maxTombstones: number;
	#uidValidity = Math.floor(Date.now() / 1000);

	constructor(maxTombstones: number) {
		this.maxTombstones = maxTombstones;
	}

	nextUidValidity(): number {
		return this.#uidValidity++;
	}

	account(id: string): AccountState {
		const state = this.accounts.get(id);
		if (!state) throw new StoreError('NOT_FOUND', `No account "${id}"`);
		return state;
	}

	mailbox(id: string): MailboxState {
		const state = this.mailboxes.get(id);
		if (!state) throw new StoreError('NOT_FOUND', `No mailbox "${id}"`);
		return state;
	}

	/** The messages for these ids, each once; `NOT_FOUND` before anything changes. */
	messagesOf(ids: readonly string[], accountId?: string): MessageState[] {
		return [...new Set(ids)].map((id) => {
			const message = this.messages.get(id);
			if (!message) throw new StoreError('NOT_FOUND', `No message "${id}"`);
			if (accountId !== undefined && message.accountId !== accountId) {
				throw new StoreError(
					'INVALID',
					'Messages only move between mailboxes of their own account',
				);
			}
			return message;
		});
	}

	/** Refuses a mailbox that has no room for `count` more UIDs. */
	checkUids(mailbox: MailboxState, count: number): void {
		if (mailbox.uidNext + count - 1 > MAX_UID) {
			throw new StoreError(
				'INVALID',
				`Mailbox "${mailbox.name}" has run out of UIDs`,
			);
		}
	}

	/** The account's next modseq. */
	bump(accountId: string): number {
		return ++this.account(accountId).modseq;
	}

	/** A message changed: a new modseq for it and for each mailbox it is, or was, in. */
	touch(message: MessageState, left?: string): number {
		const modseq = this.bump(message.accountId);
		message.modseq = modseq;
		for (const mailboxId of message.mailboxes.keys())
			this.#raise(mailboxId, modseq);
		if (left !== undefined) this.#raise(left, modseq);
		return modseq;
	}

	#raise(mailboxId: string, modseq: number): void {
		const mailbox = this.mailboxes.get(mailboxId);
		if (mailbox) mailbox.highestModseq = modseq;
	}

	/** Remembers what is gone, for the changes; past `maxTombstones`, the oldest is forgotten. */
	bury(accountId: string, tombstone: Tombstone): void {
		const account = this.account(accountId);
		account.tombstones.push(tombstone);
		while (account.tombstones.length > this.maxTombstones) {
			account.floor = (account.tombstones.shift() as Tombstone).modseq;
		}
	}

	retain(blobId: string, bytes?: Uint8Array): void {
		const blob = this.blobs.get(blobId);
		if (blob) blob.uses++;
		else if (bytes) this.blobs.set(blobId, { bytes, uses: 1 });
	}

	release(blobId: string): void {
		const blob = this.blobs.get(blobId);
		if (blob && --blob.uses === 0) this.blobs.delete(blobId);
	}

	/** A copy of the mailbox, with its counts. */
	mailboxView(state: MailboxState): Mailbox {
		let messages = 0;
		let unseen = 0;
		for (const message of this.messages.values()) {
			if (!message.mailboxes.has(state.id)) continue;
			messages++;
			if (!message.flags.includes(SEEN)) unseen++;
		}
		return {
			id: state.id,
			accountId: state.accountId,
			name: state.name,
			...(state.parentId === undefined ? {} : { parentId: state.parentId }),
			...(state.role === undefined ? {} : { role: state.role }),
			uidValidity: state.uidValidity,
			uidNext: state.uidNext,
			highestModseq: state.highestModseq,
			messages,
			unseen,
		};
	}

	/** A copy of the message: its flags, its date and its mailboxes are the caller's. */
	messageView(state: MessageState): Message {
		return {
			id: state.id,
			accountId: state.accountId,
			blobId: state.blobId,
			size: state.size,
			flags: [...state.flags],
			receivedAt: new Date(state.receivedAt),
			createdModseq: state.createdModseq,
			modseq: state.modseq,
			mailboxes: [...state.mailboxes].map(([mailboxId, { uid, modseq }]) => ({
				mailboxId,
				uid,
				modseq,
			})),
		};
	}
}
