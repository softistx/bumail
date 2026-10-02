/** An account: one login, owning mailboxes. */
export interface Account {
	readonly id: string;
	/** The login, usually the account's address; unique, compared case-insensitively. */
	readonly name: string;
}

/** The special use of a mailbox (RFC 6154, RFC 8621 §2). */
export type MailboxRole =
	| 'inbox'
	| 'drafts'
	| 'sent'
	| 'trash'
	| 'junk'
	| 'archive';

export interface Mailbox {
	readonly id: string;
	readonly accountId: string;
	readonly name: string;
	/** The parent mailbox, for a hierarchy; `undefined` at the top. */
	readonly parentId?: string;
	readonly role?: MailboxRole;
	/** IMAP's UIDVALIDITY (RFC 9051 §2.3.1.1): fixed for the mailbox's life. */
	readonly uidValidity: number;
	/** The UID the next message added to this mailbox gets. */
	readonly uidNext: number;
	/** The highest modseq of anything in this mailbox (RFC 7162). */
	readonly highestModseq: number;
	readonly messages: number;
	readonly unseen: number;
}

/** A message in a mailbox. The same content in two mailboxes is two messages sharing a blob. */
export interface Message {
	readonly id: string;
	readonly accountId: string;
	readonly mailboxId: string;
	/** Strictly ascending within its mailbox, never reused (RFC 9051 §2.3.1.1). */
	readonly uid: number;
	/** The account-wide change counter when the message was added or last changed. */
	readonly modseq: number;
	/** System flags (`\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`) and keywords, sorted. */
	readonly flags: readonly string[];
	/** When the message was received (IMAP's INTERNALDATE, JMAP's `receivedAt`). */
	readonly receivedAt: Date;
	/** The size of the message in bytes. */
	readonly size: number;
	/** The content's blob: the SHA-256 of its bytes, in hex. */
	readonly blobId: string;
}

/** A message removed from a mailbox, kept so a client can learn it is gone (RFC 7162 QRESYNC, JMAP `/changes`). */
export interface Removed {
	readonly id: string;
	readonly mailboxId: string;
	readonly uid: number;
	readonly modseq: number;
}

/** What changed in an account since a modseq. */
export interface Changes {
	/** The account's modseq now: pass it back as `since` next time. */
	readonly modseq: number;
	/** Messages added or changed since, in modseq order. */
	readonly messages: readonly Message[];
	/** Messages removed since. */
	readonly removed: readonly Removed[];
}

export interface NewMessage {
	readonly content: Uint8Array;
	readonly flags?: readonly string[];
	/** Default: now. */
	readonly receivedAt?: Date;
}

export interface FlagChange {
	readonly add?: readonly string[];
	readonly remove?: readonly string[];
	/** Replaces every flag; applied before `add` and `remove`. */
	readonly set?: readonly string[];
}

export interface NewMailbox {
	readonly name: string;
	readonly parentId?: string;
	readonly role?: MailboxRole;
}

/**
 * Where a mail server keeps its mail. Every store — in memory, on
 * `bun:sqlite`, elsewhere — answers this contract the same way, and is held
 * to it by the same specs; whoever uses a store never knows which one it
 * was given. Every method is asynchronous, so a store may live across a
 * network.
 *
 * Errors are `StoreError`s: `NOT_FOUND` for an id that names nothing,
 * `ALREADY_EXISTS` for a duplicate account or mailbox name, `INVALID` for
 * a value the contract refuses.
 */
export interface MailStore {
	createAccount(name: string): Promise<Account>;
	getAccount(id: string): Promise<Account | undefined>;
	/** The account with this login, compared case-insensitively. */
	findAccount(name: string): Promise<Account | undefined>;
	/** Deletes the account, its mailboxes and its messages. */
	deleteAccount(id: string): Promise<void>;

	createMailbox(accountId: string, mailbox: NewMailbox): Promise<Mailbox>;
	getMailbox(id: string): Promise<Mailbox | undefined>;
	listMailboxes(accountId: string): Promise<Mailbox[]>;
	/** The account's mailbox with this role, such as `inbox`. */
	findMailbox(
		accountId: string,
		role: MailboxRole,
	): Promise<Mailbox | undefined>;
	renameMailbox(id: string, name: string, parentId?: string): Promise<Mailbox>;
	/** Deletes an empty mailbox with no children; `INVALID` otherwise. */
	deleteMailbox(id: string): Promise<void>;

	/** Adds a message: the next UID of the mailbox, the next modseq of the account. */
	addMessage(mailboxId: string, message: NewMessage): Promise<Message>;
	getMessage(id: string): Promise<Message | undefined>;
	/** The mailbox's messages in UID order, from `fromUid` when given. */
	listMessages(mailboxId: string, fromUid?: number): Promise<Message[]>;
	/** The bytes of a message's content. */
	readContent(blobId: string): Promise<Uint8Array | undefined>;
	/** Changes the flags of messages; each one changed gets a new modseq. */
	setFlags(ids: readonly string[], change: FlagChange): Promise<Message[]>;
	/** Copies messages into another mailbox of the same account, sharing their blobs. */
	copyMessages(ids: readonly string[], mailboxId: string): Promise<Message[]>;
	/** Moves messages: a copy, then the originals removed (RFC 6851). */
	moveMessages(ids: readonly string[], mailboxId: string): Promise<Message[]>;
	/** Removes messages; a blob no message uses any more is dropped. */
	removeMessages(ids: readonly string[]): Promise<Removed[]>;

	/** What changed in an account since a modseq: what `Changes.modseq` returned before, or 0. */
	changes(accountId: string, since: number): Promise<Changes>;
}
