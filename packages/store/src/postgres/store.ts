import type { MailStore } from '../contract/mail-store';
import type * as T from '../contract/types';
import { StoreError } from '../errors';
import { masked } from '../masked';
import * as accounts from './accounts';
import { mailboxChanges, messageChanges } from './changes';
import { type Connection, connect } from './connect';
import * as copies from './copies';
import { setFlags } from './flags';
import * as mailboxes from './mailboxes';
import * as membership from './membership';
import * as messages from './messages';
import type { PostgresMailStoreOptions } from './options';
import { deleteMailbox } from './removal';
import { migrate } from './schema';
import { PgState } from './state';

export type {
	PostgresClient,
	PostgresMailStoreOptions,
	PostgresQueryable,
} from './options';

const messageOf = (error: unknown) =>
	error instanceof Error ? error.message : String(error);

/**
 * A `MailStore` on PostgreSQL through Bun's own `Bun.SQL`: several server
 * instances, on one machine or many, share one store. Every write runs in
 * one transaction that first locks its account's row, so the writes of an
 * account run one after the other wherever they come from, and modseqs,
 * UIDs and the tombstones the changes read are only ever given under that
 * lock; reads of several statements run in one `REPEATABLE READ`
 * snapshot. Content is kept in the database, once per distinct bytes in
 * an account. The tables are made, or brought up to date, by `migrate()`,
 * or by the first call that needs them.
 */
export class PostgresMailStore implements MailStore {
	readonly #connection: Connection;
	readonly #state: PgState;
	#migrated: Promise<void> | undefined;
	#closed = false;

	private constructor(connection: Connection) {
		this.#connection = connection;
		this.#state = new PgState(
			connection.client,
			connection.tables,
			connection.maxTombstones,
			() => this.#ready(),
		);
	}

	/** Checks the options; connects to nothing until the first call. What is wrong is `INVALID`. */
	static open(options: PostgresMailStoreOptions): PostgresMailStore {
		return new PostgresMailStore(connect(options));
	}

	/**
	 * Makes the tables, or brings them to the last migration; once per
	 * store, and safe while other instances do the same. Tables already
	 * current are only read, so a role without `CREATE` runs the store once
	 * they are made. A failure is `INVALID`, and the next call tries again.
	 */
	migrate(): Promise<void> {
		if (this.#closed) return Promise.reject(closed());
		const { client, tables } = this.#connection;
		this.#migrated ??= migrate(client, tables).catch((error) => {
			this.#migrated = undefined;
			if (error instanceof StoreError) throw error;
			throw new StoreError(
				'INVALID',
				`The PostgreSQL mail store cannot be set up: ${masked(messageOf(error), this.#connection.password)}`,
			);
		});
		return this.#migrated;
	}

	/** Closes the client the store opened for a URL, never one it was given; closing twice is fine. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		if (this.#connection.owned) await this.#connection.client.close();
	}

	/** The tables are there, and the store is open: `INVALID` once closed. */
	async #ready(): Promise<void> {
		if (this.#closed) throw closed();
		await this.migrate();
	}

	async createAccount(name: string): Promise<T.Account> {
		return accounts.createAccount(this.#state, name);
	}

	async getAccount(id: string): Promise<T.Account | undefined> {
		return accounts.getAccount(this.#state, id);
	}

	async findAccount(name: string): Promise<T.Account | undefined> {
		return accounts.findAccount(this.#state, name);
	}

	async deleteAccount(id: string): Promise<void> {
		return accounts.deleteAccount(this.#state, id);
	}

	async createMailbox(
		accountId: string,
		mailbox: T.NewMailbox,
	): Promise<T.Mailbox> {
		return mailboxes.createMailbox(this.#state, accountId, mailbox);
	}

	async getMailbox(
		accountId: string,
		id: string,
	): Promise<T.Mailbox | undefined> {
		return mailboxes.getMailbox(this.#state, accountId, id);
	}

	async listMailboxes(accountId: string): Promise<T.Mailbox[]> {
		return mailboxes.listMailboxes(this.#state, accountId);
	}

	async findMailbox(
		accountId: string,
		role: T.MailboxRole,
	): Promise<T.Mailbox | undefined> {
		return mailboxes.findMailbox(this.#state, accountId, role);
	}

	async renameMailbox(
		accountId: string,
		id: string,
		change: T.MailboxRename,
	): Promise<T.Mailbox> {
		return mailboxes.renameMailbox(this.#state, accountId, id, change);
	}

	async setSubscribed(
		accountId: string,
		id: string,
		subscribed: boolean,
	): Promise<T.Mailbox> {
		return mailboxes.setSubscribed(this.#state, accountId, id, subscribed);
	}

	async deleteMailbox(
		accountId: string,
		id: string,
		options: { readonly removeMessages?: boolean } = {},
	): Promise<void> {
		return deleteMailbox(
			this.#state,
			accountId,
			id,
			options?.removeMessages === true,
		);
	}

	async addMessage(
		accountId: string,
		mailboxId: string,
		message: T.NewMessage,
	): Promise<T.Message> {
		return messages.addMessage(this.#state, accountId, mailboxId, message);
	}

	async getMessage(
		accountId: string,
		id: string,
	): Promise<T.Message | undefined> {
		return messages.getMessage(this.#state, accountId, id);
	}

	async listMessages(
		accountId: string,
		mailboxId: string,
		options: T.ListOptions = {},
	): Promise<T.MailboxEntry[]> {
		return messages.listMessages(
			this.#state,
			accountId,
			mailboxId,
			options ?? {},
		);
	}

	async listAccountMessages(
		accountId: string,
		options: T.AccountListOptions = {},
	): Promise<T.MessagePage> {
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
		change: T.FlagChange,
		options: T.FlagOptions = {},
	): Promise<T.FlagResult> {
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
	): Promise<T.MessagesResult> {
		return copies.copyMessages(this.#state, accountId, ids, mailboxId);
	}

	async linkMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<T.MessagesResult> {
		return copies.linkMessages(this.#state, accountId, ids, mailboxId);
	}

	async moveMessages(
		accountId: string,
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<T.MessagesResult> {
		return membership.moveMessages(this.#state, accountId, ids, from, to);
	}

	async removeMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<T.ExpungeResult> {
		return membership.removeMessages(this.#state, accountId, ids, mailboxId);
	}

	async destroyMessages(
		accountId: string,
		ids: readonly string[],
	): Promise<T.ExpungeResult> {
		return membership.destroyMessages(this.#state, accountId, ids);
	}

	async messageChanges(
		accountId: string,
		since: number,
		options: T.MessageChangesOptions = {},
	): Promise<T.MessageChanges> {
		return messageChanges(this.#state, accountId, since, options ?? {});
	}

	async mailboxChanges(
		accountId: string,
		since: number,
		options: T.ChangesOptions = {},
	): Promise<T.MailboxChanges> {
		return mailboxChanges(this.#state, accountId, since, options ?? {});
	}
}

const closed = () => new StoreError('INVALID', 'The store is closed');
