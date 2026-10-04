import { renameTarget } from '../contract/checks';
import {
	checkNewMailbox,
	checkSubscribed,
	type MailboxLookups,
	placeMailbox,
} from '../contract/mailbox-checks';
import { checkRequiredRole } from '../contract/mailbox-name';
import type {
	Mailbox,
	MailboxRename,
	MailboxRole,
	NewMailbox,
} from '../contract/types';
import { StoreError } from '../errors';
import type { Db, PgState, Writer } from './state';
import { isStorable } from './storable';

interface Place {
	id: string;
	name: string;
	parent_id: string | null;
	role: string | null;
}

/**
 * The account's mailboxes, as the shared checks ask about them: read
 * once, under the account's lock, so they stay true until the commit.
 */
async function lookups(w: Writer): Promise<MailboxLookups> {
	const places = await w.rows<Place>(
		`SELECT id, name, parent_id, role FROM ${w.t.mailboxes} WHERE account_id = $1`,
		[w.accountId],
	);
	const byId = new Map(places.map((place) => [place.id, place]));
	return {
		checkParent: (id) => {
			if (!byId.has(id))
				throw new StoreError('NOT_FOUND', `No mailbox "${id}"`);
		},
		parentOf: (id) => byId.get(id)?.parent_id ?? undefined,
		isTaken: (name, parentId, self) =>
			places.some(
				(place) =>
					place.id !== self &&
					place.name === name &&
					(place.parent_id ?? undefined) === parentId,
			),
		hasRole: (role) => places.some((place) => place.role === role),
	};
}

/** Refuses a name PostgreSQL would not keep as given; the shared checks run first. */
function checkStorableName(name: string): void {
	if (!isStorable(name)) {
		throw new StoreError(
			'INVALID',
			'A mailbox name PostgreSQL keeps holds no NUL and no lone surrogate',
		);
	}
}

export function createMailbox(
	state: PgState,
	accountId: string,
	input: NewMailbox,
): Promise<Mailbox> {
	return state.write(accountId, async (w) => {
		const name = checkNewMailbox(await lookups(w), input);
		checkStorableName(name);
		const modseq = w.bump();
		const id = crypto.randomUUID();
		await w.rows(
			`INSERT INTO ${w.t.mailboxes} (id, account_id, name, parent_id, role,
				is_subscribed, uid_validity, uid_next, created_modseq, modseq, highest_modseq)
			VALUES ($1, $2, $3, $4, $5, $6, $7::bigint, 1, $8::bigint, $8::bigint, $8::bigint)`,
			[
				id,
				accountId,
				name,
				input.parentId ?? null,
				input.role ?? null,
				input.isSubscribed !== false,
				await w.nextUidValidity(),
				modseq,
			],
		);
		return w.mailboxView(id);
	});
}

export function findMailbox(
	state: PgState,
	accountId: string,
	role: MailboxRole,
): Promise<Mailbox | undefined> {
	return state.read(async (db) => {
		await db.account(accountId);
		checkRequiredRole(role);
		const [view] = await db.mailboxViews(
			'mb.account_id = $1 AND mb.role = $2',
			[accountId, role],
		);
		return view;
	});
}

export function getMailbox(
	state: PgState,
	accountId: string,
	id: string,
): Promise<Mailbox | undefined> {
	return state.read(async (db) => {
		await db.account(accountId);
		if (!isStorable(id)) return undefined;
		const [view] = await db.mailboxViews('mb.id = $1 AND mb.account_id = $2', [
			id,
			accountId,
		]);
		return view;
	});
}

export function listMailboxes(
	state: PgState,
	accountId: string,
): Promise<Mailbox[]> {
	return state.read(async (db: Db) => {
		await db.account(accountId);
		return db.mailboxViews('mb.account_id = $1', [accountId]);
	});
}

export function renameMailbox(
	state: PgState,
	accountId: string,
	id: string,
	change: MailboxRename,
): Promise<Mailbox> {
	return state.write(accountId, async (w) => {
		const row = await w.mailboxIn(accountId, id);
		const { name, parentId } = renameTarget(
			{
				name: row.name,
				...(row.parent_id === null ? {} : { parentId: row.parent_id }),
			},
			change,
		);
		const placed = placeMailbox(await lookups(w), name, parentId, row.id);
		checkStorableName(placed);
		await w.rows(
			`UPDATE ${w.t.mailboxes} SET name = $1, parent_id = $2, modseq = $3::bigint
			WHERE id = $4`,
			[placed, parentId ?? null, w.bump(), row.id],
		);
		return w.mailboxView(row.id);
	});
}

export function setSubscribed(
	state: PgState,
	accountId: string,
	id: string,
	subscribed: boolean,
): Promise<Mailbox> {
	return state.write(accountId, async (w) => {
		const row = await w.mailboxIn(accountId, id);
		checkSubscribed(subscribed);
		if (row.is_subscribed !== subscribed) {
			await w.rows(
				`UPDATE ${w.t.mailboxes} SET is_subscribed = $1, modseq = $2::bigint
				WHERE id = $3`,
				[subscribed, w.bump(), row.id],
			);
		}
		return w.mailboxView(row.id);
	});
}
