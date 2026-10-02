/** An account: one login, owning mailboxes and messages. */
export interface Account {
	readonly id: string;
	/** The login, usually the account's address; unique, compared case-insensitively. */
	readonly name: string;
}

/**
 * The special use of a mailbox: `inbox`, and the IANA registry of IMAP
 * mailbox name attributes RFC 8621 §2 draws its roles from — RFC 6154's
 * `\All`, `\Archive`, `\Drafts`, `\Flagged`, `\Junk`, `\Sent`,
 * `\Trash`, and RFC 8457's `\Important`.
 */
export type MailboxRole =
	| 'inbox'
	| 'all'
	| 'archive'
	| 'drafts'
	| 'flagged'
	| 'important'
	| 'junk'
	| 'sent'
	| 'trash';

export interface Mailbox {
	readonly id: string;
	readonly accountId: string;
	/** Never holds `/`; `INBOX` at the top is spelt so, whatever case it was given in. */
	readonly name: string;
	/** The parent mailbox, for a hierarchy; `undefined` at the top. */
	readonly parentId?: string;
	readonly role?: MailboxRole;
	/** IMAP SUBSCRIBE (RFC 9051 §6.3.7), JMAP's `isSubscribed`. */
	readonly isSubscribed: boolean;
	/** IMAP's UIDVALIDITY (RFC 9051 §2.3.1.1): fixed for the mailbox's life, never given twice. */
	readonly uidValidity: number;
	/** The UID the next message added to this mailbox gets. */
	readonly uidNext: number;
	/** The highest modseq of the mailbox's messages, expunges included (RFC 7162); at least 1. */
	readonly highestModseq: number;
	readonly messages: number;
	readonly unseen: number;
}

/** A message's place in one mailbox. */
export interface Membership {
	readonly mailboxId: string;
	/** Strictly ascending within the mailbox, never reused (RFC 9051 §2.3.1.1). */
	readonly uid: number;
	/** The modseq at which the message joined the mailbox. */
	readonly modseq: number;
}

/**
 * One message — JMAP's Email (RFC 8621 §4): one id for its life, its
 * flags its own, in one mailbox or several. Moving it keeps its id;
 * copying it makes another message.
 */
export interface Message {
	readonly id: string;
	readonly accountId: string;
	/** The thread it belongs to (JMAP's `threadId`); fixed for its life. */
	readonly threadId: string;
	/** The content's blob, in its account: the SHA-256 of its bytes, in hex. */
	readonly blobId: string;
	/** The size of the content in bytes. */
	readonly size: number;
	/** System flags (`\Seen`, `\Answered`, `\Flagged`, `\Deleted`, `\Draft`) and keywords, lowercase; sorted. */
	readonly flags: readonly string[];
	/** When the message was received (IMAP's INTERNALDATE, JMAP's `receivedAt`). */
	readonly receivedAt: Date;
	/** The account's modseq when the message was added. */
	readonly createdModseq: number;
	/** The account's modseq when the message was added or last changed: flags or mailboxes. */
	readonly modseq: number;
	/** Where the message is; never empty. */
	readonly mailboxes: readonly Membership[];
}

/** A message in one mailbox, as IMAP sees it. Its MODSEQ is `message.modseq`. */
export interface MailboxEntry {
	readonly uid: number;
	readonly message: Message;
}

/** A message that left a mailbox: QRESYNC's VANISHED (RFC 7162 §3.2.10). */
export interface Expunged {
	readonly messageId: string;
	readonly mailboxId: string;
	readonly uid: number;
	readonly modseq: number;
}

/** What changed among an account's messages since a modseq (JMAP `Email/changes`). */
export interface MessageChanges {
	/** Pass it back as `since` next time. */
	readonly modseq: number;
	/** `limit` cut the answer short: ask again from `modseq`. */
	readonly hasMore: boolean;
	readonly created: readonly string[];
	/** Flags or mailboxes changed. */
	readonly updated: readonly string[];
	/** Gone from every mailbox. */
	readonly destroyed: readonly string[];
	/** Every message that left a mailbox in the same range, for IMAP. */
	readonly expunged: readonly Expunged[];
}

/** What changed among an account's mailboxes since a modseq (JMAP `Mailbox/changes`). */
export interface MailboxChanges {
	readonly modseq: number;
	readonly hasMore: boolean;
	readonly created: readonly string[];
	/** Renamed, moved, or its messages or counts changed. */
	readonly updated: readonly string[];
	readonly destroyed: readonly string[];
}

/** A message's bytes: whole, or as a stream the store reads to its end. */
export type Content = Uint8Array | ReadableStream<Uint8Array>;

export interface NewMessage {
	readonly content: Content;
	/** The thread to put it in; by default, a thread of its own: its own id. */
	readonly threadId?: string;
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

export interface FlagOptions {
	/** RFC 7162 UNCHANGEDSINCE: a message changed after this modseq is left alone and listed in `modified`. */
	readonly unchangedSince?: number;
}

/**
 * What a call given several ids did. An id that names no message — never
 * did, was destroyed meanwhile, belongs to another account, or is not in
 * the mailbox the call works on — is skipped and listed in `notFound`, so
 * the rest still happens: IMAP acts on the messages that remain, JMAP
 * answers `notFound` per id.
 */
export interface MessagesResult {
	/** The messages, as they are after the call; each once. */
	readonly messages: readonly Message[];
	readonly notFound: readonly string[];
}

export interface FlagResult extends MessagesResult {
	/** The ids `unchangedSince` refused (RFC 7162 MODIFIED); not in `messages`. */
	readonly modified: readonly string[];
}

/** What a removal did: what left which mailbox, and the ids skipped. */
export interface ExpungeResult {
	readonly expunged: readonly Expunged[];
	readonly notFound: readonly string[];
}

export interface NewMailbox {
	readonly name: string;
	readonly parentId?: string;
	readonly role?: MailboxRole;
	/** Default: `true`. */
	readonly isSubscribed?: boolean;
}

export interface ListOptions {
	/** From this UID up. */
	readonly fromUid?: number;
	/** Only messages changed after this modseq (RFC 7162 CHANGEDSINCE). */
	readonly changedSince?: number;
}

export interface AccountListOptions {
	/** Skip this many. Default 0. */
	readonly offset?: number;
	/** At most this many. Default: all. */
	readonly limit?: number;
}

/** A page of an account's messages, oldest added first (JMAP `Email/query`). */
export interface MessagePage {
	readonly messages: readonly Message[];
	/** Every message of the account, whatever the page. */
	readonly total: number;
}

export interface ChangesOptions {
	/** At most this many ids in created, updated and destroyed together (JMAP `maxChanges`). */
	readonly limit?: number;
}
