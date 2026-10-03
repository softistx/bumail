import { checkMaxTombstones } from '../contract/checks';
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
import { mailboxChanges, messageChanges } from './changes';
import * as copies from './copies';
import { setFlags } from './flags';
import * as mailboxes from './mailboxes';
import * as membership from './membership';
import * as messages from './messages';
import { openDirectory, type SqliteMailStoreOptions } from './open';
import { deleteMailbox } from './removal';
import { SqliteState } from './state';

export type { SqliteMailStoreOptions } from './open';

/**
 * A `MailStore` on `bun:sqlite`: one directory holding `mail.sqlite` and
 * the blobs, opened by one process at a time. Every operation runs in one
 * transaction, without awaiting, so concurrent calls never interleave; an
 * add writes its content before its transaction, and a removal drops the
 * blobs no account holds any more once its transaction is over.
 */
export class SqliteMailStore implements MailStore {
	readonly #opened: SqliteState;

	private constructor(state: SqliteState) {
		this.#opened = state;
	}

	/** The database, or `INVALID` once closed, rather than SQLite's own error. */
	get #state(): SqliteState {
		if (this.#opened.closed) {
			throw new StoreError('INVALID', 'The store is closed');
		}
		return this.#opened;
	}

	/**
	 * Opens the store in `directory`, creating it if need be. A directory
	 * another store holds open, or one that cannot be opened, is `INVALID`.
	 */
	static open(options: SqliteMailStoreOptions): SqliteMailStore {
		const max = checkMaxTombstones(
			(options as SqliteMailStoreOptions | undefined)?.maxTombstones,
		);
		const { db, blobs } = openDirectory(options);
		return new SqliteMailStore(new SqliteState(db, blobs, max));
	}

	/** Lets go of the database, and of its lock; closing twice is fine. */
	close(): void {
		this.#opened.close();
	}

	/** Runs an operation that may release blobs, then drops those no one holds. */
	async #releasing<T>(run: (state: SqliteState) => T): Promise<T> {
		const state = this.#state;
		const result = run(state);
		await state.collect();
		return result;
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

	deleteAccount(id: string): Promise<void> {
		return this.#releasing((state) => accounts.deleteAccount(state, id));
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

	deleteMailbox(
		accountId: string,
		id: string,
		options: { readonly removeMessages?: boolean } = {},
	): Promise<void> {
		return this.#releasing((state) =>
			deleteMailbox(state, accountId, id, options?.removeMessages === true),
		);
	}

	async addMessage(
		accountId: string,
		mailboxId: string,
		message: NewMessage,
	): Promise<Message> {
		return messages.addMessage(this.#state, accountId, mailboxId, message);
	}

	async getMessage(
		accountId: string,
		id: string,
	): Promise<Message | undefined> {
		return messages.getMessage(this.#state, accountId, id);
	}

	async listMessages(
		accountId: string,
		mailboxId: string,
		options: ListOptions = {},
	): Promise<MailboxEntry[]> {
		return messages.listMessages(
			this.#state,
			accountId,
			mailboxId,
			options ?? {},
		);
	}

	async listAccountMessages(
		accountId: string,
		options: AccountListOptions = {},
	): Promise<MessagePage> {
		return messages.listAccountMessages(this.#state, accountId, options ?? {});
	}

	async readContent(
		accountId: string,
		blobId: string,
	): Promise<Blob | undefined> {
		return messages.readContent(this.#state, accountId, blobId);
	}

	async setFlags(
		accountId: string,
		ids: readonly string[],
		change: FlagChange,
		options: FlagOptions = {},
	): Promise<FlagResult> {
		return setFlags(
			this.#state,
			accountId,
			ids,
			change,
			options?.unchangedSince,
		);
	}

	async copyMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<MessagesResult> {
		return copies.copyMessages(this.#state, accountId, ids, mailboxId);
	}

	async linkMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<MessagesResult> {
		return copies.linkMessages(this.#state, accountId, ids, mailboxId);
	}

	async moveMessages(
		accountId: string,
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<MessagesResult> {
		return membership.moveMessages(this.#state, accountId, ids, from, to);
	}

	removeMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<ExpungeResult> {
		return this.#releasing((state) =>
			membership.removeMessages(state, accountId, ids, mailboxId),
		);
	}

	destroyMessages(
		accountId: string,
		ids: readonly string[],
	): Promise<ExpungeResult> {
		return this.#releasing((state) =>
			membership.destroyMessages(state, accountId, ids),
		);
	}

	async messageChanges(
		accountId: string,
		since: number,
		options: MessageChangesOptions = {},
	): Promise<MessageChanges> {
		return messageChanges(this.#state, accountId, since, options ?? {});
	}

	async mailboxChanges(
		accountId: string,
		since: number,
		options: ChangesOptions = {},
	): Promise<MailboxChanges> {
		return mailboxChanges(this.#state, accountId, since, options ?? {});
	}
}
