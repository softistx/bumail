import { blobIdOf } from '../contract/blob';
import {
	applyFlagChange,
	hasControl,
	normalizeFlags,
	sameFlags,
} from '../contract/flags';
import type {
	Account,
	Changes,
	FlagChange,
	Mailbox,
	MailboxRole,
	MailStore,
	Message,
	NewMailbox,
	NewMessage,
	Removed,
} from '../contract/types';
import { StoreError } from '../errors';

interface MailboxState {
	id: string;
	accountId: string;
	name: string;
	parentId?: string;
	role?: MailboxRole;
	uidValidity: number;
	uidNext: number;
	highestModseq: number;
}

interface AccountState {
	account: Account;
	modseq: number;
	removed: Removed[];
}

const SEEN = '\\Seen';

/**
 * A `MailStore` in memory: for specs, and for a server whose mail need not
 * outlive the process. Removed messages are remembered for `changes` for
 * the life of the store.
 */
export class MemoryMailStore implements MailStore {
	readonly #accounts = new Map<string, AccountState>();
	readonly #mailboxes = new Map<string, MailboxState>();
	readonly #messages = new Map<string, Message>();
	readonly #blobs = new Map<string, { content: Uint8Array; uses: number }>();
	#uidValidity = Math.floor(Date.now() / 1000);

	#account(id: string): AccountState {
		const state = this.#accounts.get(id);
		if (!state) throw new StoreError('NOT_FOUND', `No account "${id}"`);
		return state;
	}

	#mailbox(id: string): MailboxState {
		const state = this.#mailboxes.get(id);
		if (!state) throw new StoreError('NOT_FOUND', `No mailbox "${id}"`);
		return state;
	}

	#message(id: string): Message {
		const message = this.#messages.get(id);
		if (!message) throw new StoreError('NOT_FOUND', `No message "${id}"`);
		return message;
	}

	#view(state: MailboxState): Mailbox {
		let messages = 0;
		let unseen = 0;
		for (const message of this.#messages.values()) {
			if (message.mailboxId !== state.id) continue;
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

	async createAccount(name: string): Promise<Account> {
		const login = name.trim();
		if (login === '')
			throw new StoreError('INVALID', 'An account needs a name');
		if (await this.findAccount(login)) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`An account "${login}" already exists`,
			);
		}
		const account = { id: crypto.randomUUID(), name: login };
		this.#accounts.set(account.id, { account, modseq: 0, removed: [] });
		return account;
	}

	async getAccount(id: string): Promise<Account | undefined> {
		return this.#accounts.get(id)?.account;
	}

	async findAccount(name: string): Promise<Account | undefined> {
		const key = name.trim().toLowerCase();
		for (const { account } of this.#accounts.values()) {
			if (account.name.toLowerCase() === key) return account;
		}
		return undefined;
	}

	async deleteAccount(id: string): Promise<void> {
		this.#account(id);
		for (const message of [...this.#messages.values()]) {
			if (message.accountId === id) this.#drop(message);
		}
		for (const mailbox of [...this.#mailboxes.values()]) {
			if (mailbox.accountId === id) this.#mailboxes.delete(mailbox.id);
		}
		this.#accounts.delete(id);
	}

	#checkName(
		accountId: string,
		name: string,
		parentId: string | undefined,
		self?: string,
	): string {
		const clean = name.trim();
		if (clean === '' || hasControl(clean)) {
			throw new StoreError('INVALID', `"${name}" is not a mailbox name`);
		}
		if (parentId !== undefined) {
			const parent = this.#mailbox(parentId);
			if (parent.accountId !== accountId) {
				throw new StoreError(
					'INVALID',
					'A parent mailbox must be in the same account',
				);
			}
			for (
				let at: MailboxState | undefined = parent;
				at;
				at =
					at.parentId === undefined
						? undefined
						: this.#mailboxes.get(at.parentId)
			) {
				if (at.id === self)
					throw new StoreError('INVALID', 'A mailbox cannot be inside itself');
			}
		}
		for (const mailbox of this.#mailboxes.values()) {
			if (
				mailbox.id !== self &&
				mailbox.accountId === accountId &&
				mailbox.parentId === parentId &&
				mailbox.name === clean
			) {
				throw new StoreError(
					'ALREADY_EXISTS',
					`A mailbox "${clean}" already exists there`,
				);
			}
		}
		return clean;
	}

	async createMailbox(
		accountId: string,
		mailbox: NewMailbox,
	): Promise<Mailbox> {
		this.#account(accountId);
		const name = this.#checkName(accountId, mailbox.name, mailbox.parentId);
		if (
			mailbox.role !== undefined &&
			(await this.findMailbox(accountId, mailbox.role))
		) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`The account already has a mailbox with the role ${mailbox.role}`,
			);
		}
		const state: MailboxState = {
			id: crypto.randomUUID(),
			accountId,
			name,
			...(mailbox.parentId === undefined ? {} : { parentId: mailbox.parentId }),
			...(mailbox.role === undefined ? {} : { role: mailbox.role }),
			uidValidity: this.#uidValidity++,
			uidNext: 1,
			highestModseq: 0,
		};
		this.#mailboxes.set(state.id, state);
		return this.#view(state);
	}

	async getMailbox(id: string): Promise<Mailbox | undefined> {
		const state = this.#mailboxes.get(id);
		return state && this.#view(state);
	}

	async listMailboxes(accountId: string): Promise<Mailbox[]> {
		this.#account(accountId);
		return [...this.#mailboxes.values()]
			.filter((mailbox) => mailbox.accountId === accountId)
			.map((mailbox) => this.#view(mailbox));
	}

	async findMailbox(
		accountId: string,
		role: MailboxRole,
	): Promise<Mailbox | undefined> {
		for (const mailbox of this.#mailboxes.values()) {
			if (mailbox.accountId === accountId && mailbox.role === role)
				return this.#view(mailbox);
		}
		return undefined;
	}

	async renameMailbox(
		id: string,
		name: string,
		parentId?: string,
	): Promise<Mailbox> {
		const state = this.#mailbox(id);
		state.name = this.#checkName(state.accountId, name, parentId, id);
		if (parentId === undefined) delete state.parentId;
		else state.parentId = parentId;
		return this.#view(state);
	}

	async deleteMailbox(id: string): Promise<void> {
		const state = this.#mailbox(id);
		for (const message of this.#messages.values()) {
			if (message.mailboxId === id)
				throw new StoreError('INVALID', 'Only an empty mailbox can be deleted');
		}
		for (const mailbox of this.#mailboxes.values()) {
			if (mailbox.parentId === id)
				throw new StoreError(
					'INVALID',
					'A mailbox with children cannot be deleted',
				);
		}
		this.#mailboxes.delete(state.id);
	}

	/** The next modseq of the account, recorded as the mailbox's highest. */
	#bump(mailbox: MailboxState): number {
		const account = this.#account(mailbox.accountId);
		account.modseq++;
		mailbox.highestModseq = account.modseq;
		return account.modseq;
	}

	#store(content: Uint8Array): string {
		const blobId = blobIdOf(content);
		const blob = this.#blobs.get(blobId);
		if (blob) blob.uses++;
		else this.#blobs.set(blobId, { content: content.slice(), uses: 1 });
		return blobId;
	}

	#insert(
		mailbox: MailboxState,
		fields: Pick<Message, 'flags' | 'receivedAt' | 'size' | 'blobId'>,
	): Message {
		const message: Message = {
			id: crypto.randomUUID(),
			accountId: mailbox.accountId,
			mailboxId: mailbox.id,
			uid: mailbox.uidNext++,
			modseq: this.#bump(mailbox),
			...fields,
		};
		this.#messages.set(message.id, message);
		return message;
	}

	async addMessage(mailboxId: string, message: NewMessage): Promise<Message> {
		const mailbox = this.#mailbox(mailboxId);
		const flags = normalizeFlags(message.flags ?? []);
		return this.#insert(mailbox, {
			flags,
			receivedAt: message.receivedAt ?? new Date(),
			size: message.content.length,
			blobId: this.#store(message.content),
		});
	}

	async getMessage(id: string): Promise<Message | undefined> {
		return this.#messages.get(id);
	}

	async listMessages(mailboxId: string, fromUid = 1): Promise<Message[]> {
		this.#mailbox(mailboxId);
		return [...this.#messages.values()]
			.filter(
				(message) => message.mailboxId === mailboxId && message.uid >= fromUid,
			)
			.sort((a, b) => a.uid - b.uid);
	}

	async readContent(blobId: string): Promise<Uint8Array | undefined> {
		return this.#blobs.get(blobId)?.content.slice();
	}

	async setFlags(
		ids: readonly string[],
		change: FlagChange,
	): Promise<Message[]> {
		const messages = ids.map((id) => this.#message(id));
		const result: Message[] = [];
		for (const message of messages) {
			const flags = applyFlagChange(message.flags, change);
			if (sameFlags(flags, message.flags)) {
				result.push(message);
				continue;
			}
			const updated = {
				...message,
				flags,
				modseq: this.#bump(this.#mailbox(message.mailboxId)),
			};
			this.#messages.set(updated.id, updated);
			result.push(updated);
		}
		return result;
	}

	async copyMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Message[]> {
		const target = this.#mailbox(mailboxId);
		const messages = ids.map((id) => this.#message(id));
		for (const message of messages) {
			if (message.accountId !== target.accountId) {
				throw new StoreError(
					'INVALID',
					'Messages can only be copied within their account',
				);
			}
		}
		return messages.map((message) => {
			(this.#blobs.get(message.blobId) as { uses: number }).uses++;
			return this.#insert(target, {
				flags: message.flags,
				receivedAt: message.receivedAt,
				size: message.size,
				blobId: message.blobId,
			});
		});
	}

	async moveMessages(
		ids: readonly string[],
		mailboxId: string,
	): Promise<Message[]> {
		const copies = await this.copyMessages(ids, mailboxId);
		await this.removeMessages(ids);
		return copies;
	}

	#drop(message: Message): void {
		this.#messages.delete(message.id);
		const blob = this.#blobs.get(message.blobId);
		if (blob && --blob.uses === 0) this.#blobs.delete(message.blobId);
	}

	async removeMessages(ids: readonly string[]): Promise<Removed[]> {
		const messages = [...new Set(ids)].map((id) => this.#message(id));
		return messages.map((message) => {
			this.#drop(message);
			const removed: Removed = {
				id: message.id,
				mailboxId: message.mailboxId,
				uid: message.uid,
				modseq: this.#bump(this.#mailbox(message.mailboxId)),
			};
			this.#account(message.accountId).removed.push(removed);
			return removed;
		});
	}

	async changes(accountId: string, since: number): Promise<Changes> {
		const account = this.#account(accountId);
		return {
			modseq: account.modseq,
			messages: [...this.#messages.values()]
				.filter(
					(message) =>
						message.accountId === accountId && message.modseq > since,
				)
				.sort((a, b) => a.modseq - b.modseq),
			removed: account.removed.filter((removed) => removed.modseq > since),
		};
	}
}
