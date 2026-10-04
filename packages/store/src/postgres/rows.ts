import { isMailboxRole } from '../contract/mailbox-name';
import type { Mailbox, Membership, Message } from '../contract/types';
import type { Tables } from './connect';

// `Bun.SQL` reads a `bigint` as a string, so every count, UID and modseq
// is turned back into a number here, the only place rows are read.

/** The rows a statement returned. */
export const rowsOf = async <T>(pending: PromiseLike<unknown>) =>
	(await pending) as T[];

/** Whether a message's flags hold `\Seen`; `chr(92)` is the backslash, whatever the server's string settings. */
export const SEEN = `jsonb_build_array(chr(92) || 'Seen')`;

type Int = number | string;

export interface AccountRow {
	readonly id: string;
	readonly name: string;
	modseq: number;
	readonly floor: number;
}

export const accountOf = (raw: {
	id: string;
	name: string;
	modseq: Int;
	floor: Int;
}): AccountRow => ({
	id: raw.id,
	name: raw.name,
	modseq: Number(raw.modseq),
	floor: Number(raw.floor),
});

export interface MailboxRow {
	readonly id: string;
	readonly account_id: string;
	readonly name: string;
	readonly parent_id: string | null;
	readonly role: string | null;
	readonly is_subscribed: boolean;
	readonly uid_validity: number;
	readonly uid_next: number;
	readonly created_modseq: number;
	readonly modseq: number;
	readonly highest_modseq: number;
}

interface RawMailbox {
	id: string;
	account_id: string;
	name: string;
	parent_id: string | null;
	role: string | null;
	is_subscribed: boolean;
	uid_validity: Int;
	uid_next: Int;
	created_modseq: Int;
	modseq: Int;
	highest_modseq: Int;
	messages?: Int;
	unseen?: Int;
}

export const MAILBOX_COLUMNS =
	'mb.id, mb.account_id, mb.name, mb.parent_id, mb.role, mb.is_subscribed, mb.uid_validity, mb.uid_next, mb.created_modseq, mb.modseq, mb.highest_modseq';

export function mailboxRowOf(raw: RawMailbox): MailboxRow {
	return {
		id: raw.id,
		account_id: raw.account_id,
		name: raw.name,
		parent_id: raw.parent_id,
		role: raw.role,
		is_subscribed: raw.is_subscribed,
		uid_validity: Number(raw.uid_validity),
		uid_next: Number(raw.uid_next),
		created_modseq: Number(raw.created_modseq),
		modseq: Number(raw.modseq),
		highest_modseq: Number(raw.highest_modseq),
	};
}

/** The mailboxes `mb`, with their counts: what a `Mailbox` is built from. */
export const mailboxViews = (t: Tables) =>
	`SELECT ${MAILBOX_COLUMNS},
		(SELECT count(*) FROM ${t.memberships} ms WHERE ms.mailbox_id = mb.id) AS messages,
		(SELECT count(*) FROM ${t.memberships} ms
			JOIN ${t.messages} m ON m.id = ms.message_id
			WHERE ms.mailbox_id = mb.id AND NOT m.flags @> ${SEEN}) AS unseen
	FROM ${t.mailboxes} mb`;

/** A copy of the mailbox, with its counts. */
export function mailboxOf(raw: RawMailbox): Mailbox {
	const row = mailboxRowOf(raw);
	return {
		id: row.id,
		accountId: row.account_id,
		name: row.name,
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		...(isMailboxRole(row.role) ? { role: row.role } : {}),
		isSubscribed: row.is_subscribed,
		uidValidity: row.uid_validity,
		uidNext: row.uid_next,
		highestModseq: row.highest_modseq,
		messages: Number(raw.messages ?? 0),
		unseen: Number(raw.unseen ?? 0),
	};
}

export interface MessageRow {
	readonly id: string;
	readonly account_id: string;
	readonly thread_id: string;
	readonly blob_id: string;
	readonly size: number;
	/** Sorted, as `normalizeFlags` sorts them. */
	readonly flags: string[];
	readonly received_at: number;
	readonly created_modseq: number;
	modseq: number;
}

interface RawMessage {
	id: string;
	account_id: string;
	thread_id: string;
	blob_id: string;
	size: Int;
	/** `jsonb`: parsed or not, depending on the client. */
	flags: string | string[];
	received_at: Int;
	created_modseq: Int;
	modseq: Int;
	/** `[mailbox_id, uid, joined_modseq]`, in the order the message joined them. */
	places?: string | [string, number, number][];
}

export const MESSAGE_COLUMNS =
	'm.id, m.account_id, m.thread_id, m.blob_id, m.size, m.flags, m.received_at, m.created_modseq, m.modseq';

const parsed = <T>(value: string | T): T =>
	typeof value === 'string' ? (JSON.parse(value) as T) : structuredClone(value);

export function messageRowOf(raw: RawMessage): MessageRow {
	return {
		id: raw.id,
		account_id: raw.account_id,
		thread_id: raw.thread_id,
		blob_id: raw.blob_id,
		size: Number(raw.size),
		flags: parsed(raw.flags),
		received_at: Number(raw.received_at),
		created_modseq: Number(raw.created_modseq),
		modseq: Number(raw.modseq),
	};
}

/** Where the message `m` is, as `places`: in the statement that reads it, so the two agree. */
export const placesOf = (t: Tables) =>
	`(SELECT coalesce(jsonb_agg(jsonb_build_array(p.mailbox_id, p.uid, p.joined_modseq)
		ORDER BY p.joined_modseq), '[]'::jsonb)
		FROM ${t.memberships} p WHERE p.message_id = m.id) AS places`;

/** The messages `m`, each with where it is: what a `Message` is built from, in one statement. */
export const messageViews = (t: Tables) =>
	`SELECT ${MESSAGE_COLUMNS}, ${placesOf(t)} FROM ${t.messages} m`;

/** A copy of the message, with its mailboxes in the order it joined them. */
export function messageOf(raw: RawMessage): Message {
	const row = messageRowOf(raw);
	const places = parsed<[string, number, number][]>(raw.places ?? []);
	return {
		id: row.id,
		accountId: row.account_id,
		threadId: row.thread_id,
		blobId: row.blob_id,
		size: row.size,
		flags: row.flags,
		receivedAt: new Date(row.received_at),
		createdModseq: row.created_modseq,
		modseq: row.modseq,
		mailboxes: places.map(
			([mailboxId, uid, modseq]): Membership => ({
				mailboxId,
				uid: Number(uid),
				modseq: Number(modseq),
			}),
		),
	};
}
