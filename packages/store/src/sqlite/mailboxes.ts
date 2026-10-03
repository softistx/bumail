import { renameTarget } from '../contract/checks';
import {
	checkNoCycle,
	checkRequiredRole,
	checkRole,
	normalizeMailboxName,
} from '../contract/mailbox-name';
import type {
	Mailbox,
	MailboxRename,
	MailboxRole,
	NewMailbox,
} from '../contract/types';
import { StoreError } from '../errors';
import type { MailboxRow, SqliteState } from './state';

/** Checks a name and a parent for a mailbox, `self` when it is a rename. */
function placeOf(
	state: SqliteState,
	accountId: string,
	name: string,
	parentId: string | undefined,
	self?: string,
): string {
	const clean = normalizeMailboxName(name, parentId);
	if (parentId !== undefined) {
		state.mailbox(accountId, parentId);
		if (self !== undefined) {
			checkNoCycle(self, parentId, (id) => state.parentOf(id));
		}
	}
	const taken = state.db
		.query<{ id: string }, [string, string, string, string]>(
			`SELECT id FROM mailboxes
			WHERE account_id = ? AND coalesce(parent_id, '') = ? AND name = ? AND id != ?`,
		)
		.get(accountId, parentId ?? '', clean, self ?? '');
	if (taken) {
		throw new StoreError(
			'ALREADY_EXISTS',
			`A mailbox "${clean}" already exists there`,
		);
	}
	return clean;
}

function roleTaken(
	state: SqliteState,
	accountId: string,
	role: MailboxRole,
): MailboxRow | undefined {
	return (
		state.db
			.query<MailboxRow, [string, string]>(
				'SELECT * FROM mailboxes WHERE account_id = ? AND role = ?',
			)
			.get(accountId, role) ?? undefined
	);
}

function insert(state: SqliteState, row: MailboxRow): void {
	state.db
		.query(
			`INSERT INTO mailboxes (id, account_id, name, parent_id, role, is_subscribed,
				uid_validity, uid_next, created_modseq, modseq, highest_modseq)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			row.id,
			row.account_id,
			row.name,
			row.parent_id,
			row.role,
			row.is_subscribed,
			row.uid_validity,
			row.uid_next,
			row.created_modseq,
			row.modseq,
			row.highest_modseq,
		);
}

export function createMailbox(
	state: SqliteState,
	accountId: string,
	input: NewMailbox,
): Mailbox {
	return state.atomic(() => {
		state.account(accountId);
		if (typeof input !== 'object' || input === null) {
			throw new StoreError('INVALID', 'A new mailbox is an object');
		}
		const name = placeOf(state, accountId, input.name, input.parentId);
		checkRole(input.role);
		if (
			input.isSubscribed !== undefined &&
			typeof input.isSubscribed !== 'boolean'
		) {
			throw new StoreError('INVALID', 'isSubscribed is true or false');
		}
		if (input.role !== undefined && roleTaken(state, accountId, input.role)) {
			throw new StoreError(
				'ALREADY_EXISTS',
				`The account already has a mailbox with the role ${input.role}`,
			);
		}
		const modseq = state.bump(accountId);
		const row: MailboxRow = {
			id: crypto.randomUUID(),
			account_id: accountId,
			name,
			parent_id: input.parentId ?? null,
			role: input.role ?? null,
			is_subscribed: input.isSubscribed === false ? 0 : 1,
			uid_validity: state.nextUidValidity(),
			uid_next: 1,
			created_modseq: modseq,
			modseq,
			highest_modseq: modseq,
		};
		insert(state, row);
		return state.mailboxView(row);
	});
}

export function findMailbox(
	state: SqliteState,
	accountId: string,
	role: MailboxRole,
): Mailbox | undefined {
	state.account(accountId);
	checkRequiredRole(role);
	const row = roleTaken(state, accountId, role);
	return row && state.mailboxView(row);
}

export function getMailbox(
	state: SqliteState,
	accountId: string,
	id: string,
): Mailbox | undefined {
	state.account(accountId);
	const row = state.findMailboxRow(accountId, id);
	return row && state.mailboxView(row);
}

export function listMailboxes(
	state: SqliteState,
	accountId: string,
): Mailbox[] {
	state.account(accountId);
	return state.db
		.query<MailboxRow, [string]>(
			'SELECT * FROM mailboxes WHERE account_id = ? ORDER BY rowid',
		)
		.all(accountId)
		.map((row) => state.mailboxView(row));
}

export function renameMailbox(
	state: SqliteState,
	accountId: string,
	id: string,
	change: MailboxRename,
): Mailbox {
	return state.atomic(() => {
		const row = state.mailbox(accountId, id);
		const { name, parentId } = renameTarget(
			{
				name: row.name,
				...(row.parent_id === null ? {} : { parentId: row.parent_id }),
			},
			change,
		);
		row.name = placeOf(state, accountId, name, parentId, row.id);
		row.parent_id = parentId ?? null;
		row.modseq = state.bump(accountId);
		state.db
			.query(
				'UPDATE mailboxes SET name = ?, parent_id = ?, modseq = ? WHERE id = ?',
			)
			.run(row.name, row.parent_id, row.modseq, row.id);
		return state.mailboxView(row);
	});
}

export function setSubscribed(
	state: SqliteState,
	accountId: string,
	id: string,
	subscribed: boolean,
): Mailbox {
	return state.atomic(() => {
		const row = state.mailbox(accountId, id);
		if (typeof subscribed !== 'boolean') {
			throw new StoreError('INVALID', 'isSubscribed is true or false');
		}
		if ((row.is_subscribed === 1) !== subscribed) {
			row.is_subscribed = subscribed ? 1 : 0;
			row.modseq = state.bump(accountId);
			state.db
				.query(
					'UPDATE mailboxes SET is_subscribed = ?, modseq = ? WHERE id = ?',
				)
				.run(row.is_subscribed, row.modseq, row.id);
		}
		return state.mailboxView(row);
	});
}

/**
 * Deletes a mailbox with no children. Before the messages slice no
 * mailbox holds a message, so `removeMessages` has nothing to remove yet.
 */
export function deleteMailbox(
	state: SqliteState,
	accountId: string,
	id: string,
): void {
	state.atomic(() => {
		const row = state.mailbox(accountId, id);
		const child = state.db
			.query<{ id: string }, [string]>(
				'SELECT id FROM mailboxes WHERE parent_id = ? LIMIT 1',
			)
			.get(id);
		if (child) {
			throw new StoreError(
				'INVALID',
				'A mailbox with children cannot be deleted',
			);
		}
		const modseq = state.bump(accountId);
		state.db.query('DELETE FROM mailboxes WHERE id = ?').run(id);
		state.buryMailbox(accountId, id, modseq, row.created_modseq);
	});
}
