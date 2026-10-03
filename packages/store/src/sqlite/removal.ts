import { hasChildren } from '../contract/conflicts';
import type { SqliteState } from './state';

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
		if (child) throw hasChildren();
		const modseq = state.bump(accountId);
		state.db.query('DELETE FROM mailboxes WHERE id = ?').run(id);
		state.buryMailbox(accountId, id, modseq, row.created_modseq);
	});
}
