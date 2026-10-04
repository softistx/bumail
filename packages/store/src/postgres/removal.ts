import { hasChildren, notEmpty } from '../contract/conflicts';
import { expunge } from './membership';
import { MESSAGE_COLUMNS, type MessageRow, messageRowOf } from './rows';
import type { PgState } from './state';
import { bury } from './tombstones';

/**
 * Deletes a mailbox with no children. One holding messages needs
 * `removeMessages`, which expunges them in the same transaction, oldest
 * added first, as the memory store does.
 */
export function deleteMailbox(
	state: PgState,
	accountId: string,
	id: string,
	removeMessages: boolean,
): Promise<void> {
	return state.write(accountId, async (w) => {
		const row = await w.mailboxIn(accountId, id);
		const child = await w.one(
			`SELECT id FROM ${w.t.mailboxes} WHERE parent_id = $1 LIMIT 1`,
			[id],
		);
		if (child) throw hasChildren();
		const inside = (
			await w.rows<Parameters<typeof messageRowOf>[0]>(
				`SELECT ${MESSAGE_COLUMNS} FROM ${w.t.memberships} ms
				JOIN ${w.t.messages} m ON m.id = ms.message_id
				WHERE ms.mailbox_id = $1 ORDER BY m.created_modseq`,
				[id],
			)
		).map(messageRowOf);
		if (inside.length > 0 && !removeMessages) throw notEmpty();
		for (const message of inside as MessageRow[]) await expunge(w, message, id);
		const modseq = w.bump();
		await w.rows(`DELETE FROM ${w.t.mailboxes} WHERE id = $1`, [id]);
		await bury(w, {
			kind: 'mailbox',
			modseq,
			id,
			createdModseq: row.created_modseq,
		});
	});
}
