import type { MailStore } from '../contract/mail-store';
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
} from '../contract/types';
import { StoreError } from '../errors';
import { mailboxChanges, messageChanges } from './changes';
import {
	createMailbox,
	deleteMailbox,
	findMailbox,
	renameMailbox,
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

	#find(name: string): Account | undefined {
		const key = String(name).trim().toLowerCase();
		for (const { account } of this.#state.accounts.values()) {
			if (account.name.toLowerCase() === key) return { ...account };
		}
		return undefined;
	}

	async createAccount(name: string): Promise<Account> {
		const login = typeof name === 'string' ? name.trim() : '';
		if (login === '')
			throw new StoreError('INVALID', 'An account needs a name');
		if (this.#find(login)) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`An account "${login}" already exists`,
			);
		}
		const account = { id: crypto.randomUUID(), name: login };
		this.#state.accounts.set(account.id, {
			account,
			modseq: 0,
			floor: 0,
			tombstones: [],
		});
		return { ...account };
	}

	async getAccount(id: string): Promise<Account | undefined> {
		const state = this.#state.accounts.get(id);
		return state && { ...state.account };
	}

	async findAccount(name: string): Promise<Account | undefined> {
		return this.#find(name);
	}

	async deleteAccount(id: string): Promise<void> {
		const state = this.#state;
		state.account(id);
		for (const message of [...state.messages.values()]) {
			if (message.accountId !== id) continue;
			state.messages.delete(message.id);
			state.release(message.blobId);
		}
		for (const mailbox of [...state.mailboxes.values()]) {
			if (mailbox.accountId === id) state.mailboxes.delete(mailbox.id);
		}
		state.accounts.delete(id);
	}

	async createMailbox(
		accountId: string,
		mailbox: NewMailbox,
	): Promise<Mailbox> {
		return createMailbox(this.#state, accountId, mailbox);
	}

	async getMailbox(id: string): Promise<Mailbox | undefined> {
		const mailbox = this.#state.mailboxes.get(id);
		return mailbox && this.#state.mailboxView(mailbox);
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
		id: string,
		name: string,
		parentId?: string,
	): Promise<Mailbox> {
		return renameMailbox(this.#state, id, name, parentId);
	}

	async deleteMailbox(
		id: string,
		options: { readonly removeMessages?: boolean } = {},
	): Promise<void> {
		deleteMailbox(this.#state, id, options.removeMessages === true);
	}

	addMessage(mailboxId: string, message: NewMessage): Promise<Message> {
		return messages.addMessage(this.#state, mailboxId, message);
	}

	async getMessage(id: string): Promise<Message | undefined> {
		const message = this.#state.messages.get(id);
		return message && this.#state.messageView(message);
	}

	async listMessages(
		mailboxId: string,
		options: ListOptions = {},
	): Promise<MailboxEntry[]> {
		return messages.listMessages(this.#state, mailboxId, options);
	}

	async readContent(blobId: string): Promise<Blob | undefined> {
		const blob = this.#state.blobs.get(blobId);
		return blob && new Blob([blob.bytes.slice()]);
	}

	async setFlags(
		ids: readonly string[],
		change: FlagChange,
		options: FlagOptions = {},
	): Promise<FlagResult> {
		return messages.setFlags(this.#state, ids, change, options.unchangedSince);
	}

	async copyMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Message[]> {
		return messages.copyMessages(this.#state, ids, mailboxId);
	}

	async linkMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Message[]> {
		return messages.linkMessages(this.#state, ids, mailboxId);
	}

	async moveMessages(
		ids: readonly string[],
		from: string,
		to: string,
	): Promise<Message[]> {
		return membership.moveMessages(this.#state, ids, from, to);
	}

	async removeMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Expunged[]> {
		return membership.removeMessages(this.#state, ids, mailboxId);
	}

	async destroyMessages(ids: readonly string[]): Promise<Expunged[]> {
		return membership.destroyMessages(this.#state, ids);
	}

	async messageChanges(
		accountId: string,
		since: number,
		options: ChangesOptions = {},
	): Promise<MessageChanges> {
		return messageChanges(this.#state, accountId, since, options);
	}

	async mailboxChanges(
		accountId: string,
		since: number,
		options: ChangesOptions = {},
	): Promise<MailboxChanges> {
		return mailboxChanges(this.#state, accountId, since, options);
	}
}
