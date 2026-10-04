import type { Mailbox, Message } from '../../contract/types';
import { StoreError } from '../../errors';
import type { Tables } from '../connect';
import type { PostgresQueryable } from '../options';
import {
	type AccountRow,
	accountOf,
	MAILBOX_COLUMNS,
	type MailboxRow,
	MESSAGE_COLUMNS,
	type MessageRow,
	mailboxOf,
	mailboxRowOf,
	mailboxViews,
	messageOf,
	messageRowOf,
	messageViews,
	rowsOf,
} from '../rows';
import { isStorable } from '../storable';

/** Statements on the store's tables, through a client or one transaction. */
export class Db {
	readonly sql: PostgresQueryable;
	readonly t: Tables;

	constructor(sql: PostgresQueryable, tables: Tables) {
		this.sql = sql;
		this.t = tables;
	}

	rows<T>(query: string, values: unknown[] = []): Promise<T[]> {
		return rowsOf<T>(this.sql.unsafe(query, values));
	}

	async one<T>(query: string, values: unknown[] = []): Promise<T | undefined> {
		return (await this.rows<T>(query, values))[0];
	}

	/** The account, or `undefined`; an id PostgreSQL cannot hold names none. */
	async findAccountRow(id: string): Promise<AccountRow | undefined> {
		if (!isStorable(id)) return undefined;
		const raw = await this.one<Parameters<typeof accountOf>[0]>(
			`SELECT id, name, modseq, floor FROM ${this.t.accounts} WHERE id = $1`,
			[id],
		);
		return raw && accountOf(raw);
	}

	/** The account, or `NOT_FOUND`. */
	async account(id: string): Promise<AccountRow> {
		const row = await this.findAccountRow(id);
		if (!row) throw noAccount(id);
		return row;
	}

	/** The account's mailbox, or `undefined`: another account's names nothing. */
	async findMailboxRow(
		accountId: string,
		id: string,
	): Promise<MailboxRow | undefined> {
		if (!isStorable(id)) return undefined;
		const raw = await this.one<Parameters<typeof mailboxRowOf>[0]>(
			`SELECT ${MAILBOX_COLUMNS} FROM ${this.t.mailboxes} mb
			WHERE mb.id = $1 AND mb.account_id = $2`,
			[id, accountId],
		);
		return raw && mailboxRowOf(raw);
	}

	/**
	 * The mailbox of an account already known to exist, or `NOT_FOUND`:
	 * an id is no key to someone else's mail.
	 */
	async mailboxIn(accountId: string, id: string): Promise<MailboxRow> {
		const row = await this.findMailboxRow(accountId, id);
		if (!row) throw new StoreError('NOT_FOUND', `No mailbox "${id}"`);
		return row;
	}

	/** The account's mailbox with this id; an unknown account is `NOT_FOUND` too. */
	async mailbox(accountId: string, id: string): Promise<MailboxRow> {
		await this.account(accountId);
		return this.mailboxIn(accountId, id);
	}

	/** The parent of a mailbox, for walking up the hierarchy. */
	async parentOf(id: string): Promise<string | undefined> {
		const row = await this.one<{ parent_id: string | null }>(
			`SELECT parent_id FROM ${this.t.mailboxes} WHERE id = $1`,
			[id],
		);
		return row?.parent_id ?? undefined;
	}

	/** Copies of the account's mailboxes this condition selects, oldest first, with their counts. */
	async mailboxViews(where: string, values: unknown[]): Promise<Mailbox[]> {
		const rows = await this.rows<Parameters<typeof mailboxOf>[0]>(
			`${mailboxViews(this.t)} WHERE ${where} ORDER BY mb.created_modseq`,
			values,
		);
		return rows.map(mailboxOf);
	}

	/** A copy of one mailbox, with its counts, as it is now. */
	async mailboxView(id: string): Promise<Mailbox> {
		const [view] = await this.mailboxViews('mb.id = $1', [id]);
		return view as Mailbox;
	}

	/** The account's message with this id, or `undefined`. */
	async messageRow(
		accountId: string,
		id: string,
	): Promise<MessageRow | undefined> {
		if (!isStorable(id)) return undefined;
		const raw = await this.one<Parameters<typeof messageRowOf>[0]>(
			`SELECT ${MESSAGE_COLUMNS} FROM ${this.t.messages} m
			WHERE m.id = $1 AND m.account_id = $2`,
			[id, accountId],
		);
		return raw && messageRowOf(raw);
	}

	/**
	 * The account's messages for these ids, each id once, in a map; ids
	 * PostgreSQL cannot hold are left out, as naming nothing. With
	 * `mailboxId`, only those in that mailbox.
	 */
	async messageRows(
		accountId: string,
		ids: readonly string[],
		mailboxId?: string,
	): Promise<Map<string, MessageRow>> {
		const wanted = ids.filter(isStorable);
		const found = new Map<string, MessageRow>();
		if (wanted.length === 0) return found;
		const inMailbox =
			mailboxId === undefined
				? ''
				: `AND EXISTS (SELECT 1 FROM ${this.t.memberships} ms
					WHERE ms.message_id = m.id AND ms.mailbox_id = $3)`;
		const rows = await this.rows<Parameters<typeof messageRowOf>[0]>(
			`SELECT ${MESSAGE_COLUMNS} FROM ${this.t.messages} m
			WHERE m.account_id = $1
				AND m.id IN (SELECT jsonb_array_elements_text($2::text::jsonb))
				${inMailbox}`,
			mailboxId === undefined
				? [accountId, JSON.stringify(wanted)]
				: [accountId, JSON.stringify(wanted), mailboxId],
		);
		for (const raw of rows) found.set(raw.id, messageRowOf(raw));
		return found;
	}

	/** Copies of the account's messages this condition selects, with their mailboxes. */
	async messageViews(
		where: string,
		values: unknown[],
		order = '',
	): Promise<Message[]> {
		const rows = await this.rows<Parameters<typeof messageOf>[0]>(
			`${messageViews(this.t)} WHERE ${where} ${order}`,
			values,
		);
		return rows.map(messageOf);
	}

	/** The messages as they are now, read again, in the order of `ids`: what an operation answers. */
	async freshViews(
		accountId: string,
		ids: readonly string[],
	): Promise<Message[]> {
		if (ids.length === 0) return [];
		const views = await this.messageViews(
			'm.account_id = $1 AND m.id IN (SELECT jsonb_array_elements_text($2::text::jsonb))',
			[accountId, JSON.stringify(ids)],
		);
		const byId = new Map(views.map((view) => [view.id, view]));
		return ids.flatMap((id) => byId.get(id) ?? []);
	}
}

export const noAccount = (id: string) =>
	new StoreError('NOT_FOUND', `No account "${id}"`);
