import type { MailStore } from '../contract/mail-store';
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
	MessageChangesOptions,
	MessagePage,
	MessagesResult,
	NewMailbox,
	NewMessage,
} from '../contract/types';
import { StoreError } from '../errors';
import * as accounts from './accounts';
import { mailboxChanges } from './changes';
import * as mailboxes from './mailboxes';
import {
	type Opened,
	openDirectory,
	type SqliteMailStoreOptions,
} from './open';
import { deleteMailbox } from './removal';
import { SqliteState } from './state';

export type { SqliteMailStoreOptions } from './open';

/** What a later slice answers: refused loudly, never faked. */
function notYet(): never {
	throw new Error('not implemented in this slice');
}

/**
 * A `MailStore` on `bun:sqlite`: one directory holding `mail.sqlite` and
 * the blobs, opened by one process at a time. Every operation runs in one
 * transaction, without awaiting, so concurrent calls never interleave.
 */
export class SqliteMailStore implements MailStore {
	readonly #opened: SqliteState;
	#closed = false;

	// The blobs are opened with the database, staging files cleared; the
	// messages slice keeps them, to write and read content.
	private constructor({ db }: Opened) {
		this.#opened = new SqliteState(db);
	}

	/** The database, or `INVALID` once closed, rather than SQLite's own error. */
	get #state(): SqliteState {
		if (this.#closed) throw new StoreError('INVALID', 'The store is closed');
		return this.#opened;
	}

	/**
	 * Opens the store in `directory`, creating it if need be. A directory
	 * another store holds open, or one that cannot be opened, is `INVALID`.
	 */
	static open(options: SqliteMailStoreOptions): SqliteMailStore {
		return new SqliteMailStore(openDirectory(options));
	}

	/** Lets go of the database, and of its lock; closing twice is fine. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#opened.db.close();
	}

	async createAccount(name: string): Promise<Account> {
		return accounts.createAccount(this.#state, name);
	}

	async getAccount(id: string): Promise<Account | undefined> {
		return accounts.getAccount(this.#state, id);
	}

	async findAccount(name: string): Promise<Account | undefined> {
		return accounts.findAccount(this.#state, name);
	}

	async deleteAccount(id: string): Promise<void> {
		accounts.deleteAccount(this.#state, id);
	}

	async createMailbox(
		accountId: string,
		mailbox: NewMailbox,
	): Promise<Mailbox> {
		return mailboxes.createMailbox(this.#state, accountId, mailbox);
	}

	async getMailbox(
		accountId: string,
		id: string,
	): Promise<Mailbox | undefined> {
		return mailboxes.getMailbox(this.#state, accountId, id);
	}

	async listMailboxes(accountId: string): Promise<Mailbox[]> {
		return mailboxes.listMailboxes(this.#state, accountId);
	}

	async findMailbox(
		accountId: string,
		role: MailboxRole,
	): Promise<Mailbox | undefined> {
		return mailboxes.findMailbox(this.#state, accountId, role);
	}

	async renameMailbox(
		accountId: string,
		id: string,
		change: MailboxRename,
	): Promise<Mailbox> {
		return mailboxes.renameMailbox(this.#state, accountId, id, change);
	}

	async setSubscribed(
		accountId: string,
		id: string,
		subscribed: boolean,
	): Promise<Mailbox> {
		return mailboxes.setSubscribed(this.#state, accountId, id, subscribed);
	}

	async deleteMailbox(
		accountId: string,
		id: string,
		_options: { readonly removeMessages?: boolean } = {},
	): Promise<void> {
		deleteMailbox(this.#state, accountId, id);
	}

	async addMessage(
		_accountId: string,
		_mailboxId: string,
		_message: NewMessage,
	): Promise<Message> {
		notYet();
	}

	async getMessage(
		_accountId: string,
		_id: string,
	): Promise<Message | undefined> {
		notYet();
	}

	async listMessages(
		_accountId: string,
		_mailboxId: string,
		_options?: ListOptions,
	): Promise<MailboxEntry[]> {
		notYet();
	}

	async listAccountMessages(
		_accountId: string,
		_options?: AccountListOptions,
	): Promise<MessagePage> {
		notYet();
	}

	async readContent(
		_accountId: string,
		_blobId: string,
	): Promise<Blob | undefined> {
		notYet();
	}

	async setFlags(
		_accountId: string,
		_ids: readonly string[],
		_change: FlagChange,
		_options?: FlagOptions,
	): Promise<FlagResult> {
		notYet();
	}

	async copyMessages(
		_accountId: string,
		_ids: readonly string[],
		_mailboxId: string,
	): Promise<MessagesResult> {
		notYet();
	}

	async linkMessages(
		_accountId: string,
		_ids: readonly string[],
		_mailboxId: string,
	): Promise<MessagesResult> {
		notYet();
	}

	async moveMessages(
		_accountId: string,
		_ids: readonly string[],
		_from: string,
		_to: string,
	): Promise<MessagesResult> {
		notYet();
	}

	async removeMessages(
		_accountId: string,
		_ids: readonly string[],
		_mailboxId: string,
	): Promise<ExpungeResult> {
		notYet();
	}

	async destroyMessages(
		_accountId: string,
		_ids: readonly string[],
	): Promise<ExpungeResult> {
		notYet();
	}

	async messageChanges(
		_accountId: string,
		_since: number,
		_options?: MessageChangesOptions,
	): Promise<MessageChanges> {
		notYet();
	}

	async mailboxChanges(
		accountId: string,
		since: number,
		options: ChangesOptions = {},
	): Promise<MailboxChanges> {
		return mailboxChanges(this.#state, accountId, since, options ?? {});
	}
}
