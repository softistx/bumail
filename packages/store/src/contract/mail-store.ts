import type {
	Account,
	AccountListOptions,
	ChangesOptions,
	ExpungeResult,
	FlagChange,
	FlagOptions,
	FlagResult,
	ListOptions,
	Mailbox,
	MailboxChanges,
	MailboxEntry,
	MailboxRename,
	MailboxRole,
	Message,
	MessageChanges,
	MessagePage,
	MessagesResult,
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
 * once, however often it is listed, and skips an id that names no message
 * of the account — listing it in `notFound` — rather than failing the rest:
 * another session may have just destroyed it.
 *
 * **Copies.** What a store returns is the caller's: changing it, or the
 * `Date` or bytes given in, never changes what the store holds.
 *
 * **Modseq.** Each account has one counter. Every change takes the next
 * value, one per message changed: an add, a flag change, a mailbox joined
 * or left, a mailbox created, renamed or deleted.
 *
 * **Growth.** In 0.x, a minor version may add members to this interface
 * and to what it returns. A store written outside this package follows
 * those versions.
 *
 * **One account at a time.** Every method past the account's own takes
 * the account it acts in, first. Another account's mailbox or message is
 * treated as an id that names nothing — `NOT_FOUND`, `notFound` or
 * `undefined` — and is never acted on: an id is no key to someone else's
 * mail.
 *
 * Errors are `StoreError`s, and only those: `NOT_FOUND` for an id that
 * names nothing, `ALREADY_EXISTS` for a duplicate login, mailbox name or
 * role, `INVALID` for a value the contract refuses,
 * `CANNOT_CALCULATE_CHANGES` for a `since` the store no longer remembers.
 * A method that takes an account id throws `NOT_FOUND` for an unknown
 * one; `get…(accountId, id)` answers `undefined` for an unknown id.
 */
export interface MailStore {
	createAccount(name: string): Promise<Account>;
	getAccount(id: string): Promise<Account | undefined>;
	/** The account with this login, compared case-insensitively. */
	findAccount(name: string): Promise<Account | undefined>;
	/** Deletes the account, its mailboxes and its messages. */
	deleteAccount(id: string): Promise<void>;

	createMailbox(accountId: string, mailbox: NewMailbox): Promise<Mailbox>;
	getMailbox(accountId: string, id: string): Promise<Mailbox | undefined>;
	listMailboxes(accountId: string): Promise<Mailbox[]>;
	/** The account's mailbox with this role, such as `inbox`. */
	findMailbox(
		accountId: string,
		role: MailboxRole,
	): Promise<Mailbox | undefined>;
	/**
	 * Renames or moves a mailbox; it keeps its id, role, subscription,
	 * UIDVALIDITY and messages. A field left out of `change` keeps its
	 * value, `parentId: null` moves the mailbox to the top, and a change
	 * with neither field is `INVALID`. Renaming the inbox keeps its role:
	 * the store has no RFC 9051 §6.3.6 "rename INBOX" that moves its
	 * messages.
	 */
	renameMailbox(
		accountId: string,
		id: string,
		change: MailboxRename,
	): Promise<Mailbox>;
	/** IMAP SUBSCRIBE and UNSUBSCRIBE; a change of the mailbox, with its modseq. */
	setSubscribed(
		accountId: string,
		id: string,
		subscribed: boolean,
	): Promise<Mailbox>;
	/**
	 * Deletes a mailbox with no children: one that has children is
	 * `INVALID` — the store keeps no `\Noselect` name (RFC 9051 §6.3.4).
	 * One holding messages needs `removeMessages`, which removes them from
	 * it in the same step (JMAP's `onDestroyRemoveEmails`).
	 */
	deleteMailbox(
		accountId: string,
		id: string,
		options?: { readonly removeMessages?: boolean },
	): Promise<void>;

	/** Adds a message: the next UID of the mailbox, the next modseq of the account. */
	addMessage(
		accountId: string,
		mailboxId: string,
		message: NewMessage,
	): Promise<Message>;
	getMessage(accountId: string, id: string): Promise<Message | undefined>;
	/** The mailbox's messages in UID order. */
	listMessages(
		accountId: string,
		mailboxId: string,
		options?: ListOptions,
	): Promise<MailboxEntry[]>;
	/** The account's messages, in every mailbox, oldest added first. */
	listAccountMessages(
		accountId: string,
		options?: AccountListOptions,
	): Promise<MessagePage>;
	/**
	 * A message's content, in the account that holds it; `blob.slice(start,
	 * end)` reads a range. Another account's blob is `undefined`, even with
	 * the same bytes: a blob id is no key to someone else's mail.
	 */
	readContent(accountId: string, blobId: string): Promise<Blob | undefined>;
	/** Changes the flags of messages; each one changed takes a new modseq. */
	setFlags(
		accountId: string,
		ids: readonly string[],
		change: FlagChange,
		options?: FlagOptions,
	): Promise<FlagResult>;
	/**
	 * IMAP COPY (RFC 9051 §6.4.7): new messages in the mailbox, with the
	 * same content, flags, date and thread, and flags of their own from then
	 * on.
	 */
	copyMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<MessagesResult>;
	/** Puts messages in one more mailbox, keeping their ids: JMAP's `mailboxIds`. Already there: unchanged. */
	linkMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<MessagesResult>;
	/**
	 * IMAP MOVE (RFC 6851): messages leave `from` and join `to`, keeping
	 * their ids. A message already in `to` keeps the UID it has there, so
	 * its UID in `to` is below `uidNext`: a COPYUID built from the result
	 * names that UID. One not in `from` is `notFound`.
	 */
	moveMessages(
		accountId: string,
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<MessagesResult>;
	/**
	 * Takes messages out of a mailbox (IMAP EXPUNGE); one left in no mailbox
	 * is destroyed. One not in the mailbox is `notFound`.
	 */
	removeMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<ExpungeResult>;
	/** Destroys messages, from every mailbox. A blob no message uses any more is dropped. */
	destroyMessages(
		accountId: string,
		ids: readonly string[],
	): Promise<ExpungeResult>;

	/**
	 * What changed among the account's messages since a modseq: one a change
	 * returned, or 0. Since 0 is always answered, as the account's whole
	 * state: every message `created`, nothing destroyed or expunged — the
	 * way to start over after `CANNOT_CALCULATE_CHANGES`. `expunged` leaves
	 * out a UID that came into its mailbox after `since`: the client never
	 * saw it.
	 */
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
