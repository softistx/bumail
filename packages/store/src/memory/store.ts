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
import {
	createMailbox,
	deleteMailbox,
	findMailbox,
	renameMailbox,
	setSubscribed,
} from './mailboxes';
import * as membership from './membership';
import * as messages from './messages';
import { MemoryState } from './state';

export interface MemoryMailStoreOptions {
	/**
	 * How many removals an account remembers for the changes. Past it, the
	 * oldest are forgotten, and a `since` before them gets
	 * `CANNOT_CALCULATE_CHANGES`. Default: all of them.
	 */
	readonly maxTombstones?: number;
}

/**
 * A `MailStore` in memory: for specs, and for a server whose mail need not
 * outlive the process. Each operation runs to its end without awaiting,
 * once its content is read, so concurrent calls never interleave.
 */
export class MemoryMailStore implements MailStore {
	readonly #state: MemoryState;

	constructor(options: MemoryMailStoreOptions = {}) {
		const max = options.maxTombstones ?? Number.POSITIVE_INFINITY;
		if (
			!(
				max === Number.POSITIVE_INFINITY ||
				(Number.isSafeInteger(max) && max >= 0)
			)
		) {
			throw new StoreError(
				'INVALID',
				`maxTombstones must be an integer of at least 0, not ${max}`,
			);
		}
		this.#state = new MemoryState(max);
	}

	async createAccount(name: string): Promise<Account> {
		return accounts.createAccount(this.#state, name);
	}

	async getAccount(id: string): Promise<Account | undefined> {
		const state = this.#state.accounts.get(id);
		return state && { ...state.account };
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
		return createMailbox(this.#state, accountId, mailbox);
	}

	async getMailbox(
		accountId: string,
		id: string,
	): Promise<Mailbox | undefined> {
		this.#state.account(accountId);
		const mailbox = this.#state.mailboxes.get(id);
		return mailbox?.accountId === accountId
			? this.#state.mailboxView(mailbox)
			: undefined;
	}

	async listMailboxes(accountId: string): Promise<Mailbox[]> {
		this.#state.account(accountId);
		return [...this.#state.mailboxes.values()]
			.filter((mailbox) => mailbox.accountId === accountId)
			.map((mailbox) => this.#state.mailboxView(mailbox));
	}

	async findMailbox(
		accountId: string,
		role: MailboxRole,
	): Promise<Mailbox | undefined> {
		const mailbox = findMailbox(this.#state, accountId, role);
		return mailbox && this.#state.mailboxView(mailbox);
	}

	async renameMailbox(
		accountId: string,
		id: string,
		change: MailboxRename,
	): Promise<Mailbox> {
		return renameMailbox(this.#state, accountId, id, change);
	}

	async setSubscribed(
		accountId: string,
		id: string,
		subscribed: boolean,
	): Promise<Mailbox> {
		return setSubscribed(this.#state, accountId, id, subscribed);
	}

	async deleteMailbox(
		accountId: string,
		id: string,
		options: { readonly removeMessages?: boolean } = {},
	): Promise<void> {
		deleteMailbox(this.#state, accountId, id, options?.removeMessages === true);
	}

	addMessage(
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
		const message = this.#state.message(accountId, id);
		return message && this.#state.messageView(message);
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
		this.#state.account(accountId);
		// A Blob cannot be changed: the store's own is handed out.
		return this.#state.blob(accountId, blobId);
	}

	async setFlags(
		accountId: string,
		ids: readonly string[],
		change: FlagChange,
		options: FlagOptions = {},
	): Promise<FlagResult> {
		return messages.setFlags(
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
		return messages.copyMessages(this.#state, accountId, ids, mailboxId);
	}

	async linkMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<MessagesResult> {
		return messages.linkMessages(this.#state, accountId, ids, mailboxId);
	}

	async moveMessages(
		accountId: string,
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<MessagesResult> {
		return membership.moveMessages(this.#state, accountId, ids, from, to);
	}

	async removeMessages(
		accountId: string,
		ids: readonly string[],
		mailboxId: string,
	): Promise<ExpungeResult> {
		return membership.removeMessages(this.#state, accountId, ids, mailboxId);
	}

	async destroyMessages(
		accountId: string,
		ids: readonly string[],
	): Promise<ExpungeResult> {
		return membership.destroyMessages(this.#state, accountId, ids);
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
