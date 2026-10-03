import { hasChildren, notEmpty } from '../contract/conflicts';
import { expunge } from './membership';
import type { MessageRow } from './rows';
import type { SqliteState } from './state';
import { bury } from './tombstones';

/**
 * Deletes a mailbox with no children. One holding messages needs
 * `removeMessages`, which expunges them in the same transaction, oldest
 * added first, as the memory store does.
 */
export function deleteMailbox(
	state: SqliteState,
	accountId: string,
	id: string,
	removeMessages: boolean,
): void {
	state.atomic(() => {
		const row = state.mailbox(accountId, id);
		const child = state.db
			.query<{ id: string }, [string]>(
				'SELECT id FROM mailboxes WHERE parent_id = ? LIMIT 1',
			)
			.get(id);
		if (child) throw hasChildren();
		const inside = state.db
			.query<MessageRow, [string]>(
				`SELECT m.* FROM memberships ms JOIN messages m ON m.id = ms.message_id
				WHERE ms.mailbox_id = ? ORDER BY m.created_modseq`,
			)
			.all(id);
		if (inside.length > 0 && !removeMessages) throw notEmpty();
		for (const message of inside) expunge(state, message, id);
		const modseq = state.bump(accountId);
		state.db.query('DELETE FROM mailboxes WHERE id = ?').run(id);
		bury(state, accountId, {
			kind: 'mailbox',
			modseq,
			id,
			createdModseq: row.created_modseq,
		});
	});
}
