import type {
	Account,
	ChangesOptions,
	Expunged,
	FlagChange,
	FlagOptions,
	FlagResult,
	ListOptions,
	Mailbox,
	MailboxChanges,
	MailboxEntry,
	MailboxRole,
	Message,
	MessageChanges,
	NewMailbox,
	NewMessage,
} from './types';

/**
 * Where a mail server keeps its mail. Every store — in memory, on
 * `bun:sqlite`, elsewhere — answers this contract the same way, and is held
 * to it by the same specs; whoever uses a store never knows which one it
 * was given. Every method is asynchronous, so a store may live across a
 * network.
 *
 * **All or nothing.** A call that rejects changed nothing, and concurrent
 * calls behave as if they ran one after the other: two creates of one name
 * give one `ALREADY_EXISTS`. A method given a list of ids takes each id
 * once, however often it is listed.
 *
 * **Copies.** What a store returns is the caller's: changing it, or the
 * `Date` or bytes given in, never changes what the store holds.
 *
 * **Modseq.** Each account has one counter. Every change takes the next
 * value, one per message changed: an add, a flag change, a mailbox joined
 * or left, a mailbox created, renamed or deleted.
 *
 * Errors are `StoreError`s: `NOT_FOUND` for an id that names nothing,
 * `ALREADY_EXISTS` for a duplicate login, mailbox name or role, `INVALID`
 * for a value the contract refuses, `CANNOT_CALCULATE_CHANGES` for a
 * `since` the store no longer remembers. A method that takes an account id
 * throws `NOT_FOUND` for an unknown one; `get…(id)` answers `undefined`.
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
	/** Renames or moves a mailbox; it keeps its id, role, UIDVALIDITY and messages. */
	renameMailbox(id: string, name: string, parentId?: string): Promise<Mailbox>;
	/**
	 * Deletes a mailbox with no children. One holding messages needs
	 * `removeMessages`, which removes them from it in the same step (RFC
	 * 9051 §6.3.4, JMAP's `onDestroyRemoveEmails`).
	 */
	deleteMailbox(
		id: string,
		options?: { readonly removeMessages?: boolean },
	): Promise<void>;

	/** Adds a message: the next UID of the mailbox, the next modseq of the account. */
	addMessage(mailboxId: string, message: NewMessage): Promise<Message>;
	getMessage(id: string): Promise<Message | undefined>;
	/** The mailbox's messages in UID order. */
	listMessages(
		mailboxId: string,
		options?: ListOptions,
	): Promise<MailboxEntry[]>;
	/** A message's content; `blob.slice(start, end)` reads a range. */
	readContent(blobId: string): Promise<Blob | undefined>;
	/** Changes the flags of messages; each one changed takes a new modseq. */
	setFlags(
		ids: readonly string[],
		change: FlagChange,
		options?: FlagOptions,
	): Promise<FlagResult>;
	/**
	 * IMAP COPY (RFC 9051 §6.4.7): new messages in the mailbox, with the
	 * same content, flags and date, and flags of their own from then on.
	 */
	copyMessages(ids: readonly string[], mailboxId: string): Promise<Message[]>;
	/** Puts messages in one more mailbox, keeping their ids: JMAP's `mailboxIds`. Already there: unchanged. */
	linkMessages(ids: readonly string[], mailboxId: string): Promise<Message[]>;
	/**
	 * IMAP MOVE (RFC 6851): messages leave `from` and join `to`, keeping
	 * their ids. A message already in `to` keeps its UID there.
	 */
	moveMessages(
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<Message[]>;
	/** Takes messages out of a mailbox (IMAP EXPUNGE); one left in no mailbox is destroyed. */
	removeMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Expunged[]>;
	/** Destroys messages, from every mailbox. A blob no message uses any more is dropped. */
	destroyMessages(ids: readonly string[]): Promise<Expunged[]>;

	/** What changed among the account's messages since a modseq: one a change returned, or 0. */
	messageChanges(
		accountId: string,
		since: number,
		options?: ChangesOptions,
	): Promise<MessageChanges>;
	/** What changed among the account's mailboxes since a modseq. */
	mailboxChanges(
		accountId: string,
		since: number,
		options?: ChangesOptions,
	): Promise<MailboxChanges>;
}
