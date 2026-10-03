import type { Message } from '@bumail/store';
import { type FetchItem, fetchItems } from '../fetch/items';
import { renderFetch } from '../fetch/render';
import { loadMessages, positionsOf } from '../mailbox/lookup';
import type { Selected } from '../mailbox/selected';
import type { Connection } from '../server/connection';
import { type Command, ok, SELECTED } from './context';

const FLAGS: FetchItem = { kind: 'FLAGS' };
const UID: FetchItem = { kind: 'UID' };

/** Whether the items read a body section without PEEK, which sets `\Seen` (§6.4.5). */
function marksSeen(items: readonly FetchItem[]): boolean {
	return items.some((item) => item.kind === 'section' && !item.peek);
}

/** Sets `\Seen` when reading sets it; the message as it is after. */
async function seen(
	connection: Connection,
	view: Selected,
	message: Message,
	items: readonly FetchItem[],
): Promise<Message> {
	if (view.readOnly || !marksSeen(items) || message.flags.includes('\\Seen'))
		return message;
	const result = await connection.settings.store.setFlags(
		connection.accountId,
		[message.id],
		{
			add: ['\\Seen'],
		},
	);
	return result.messages[0] ?? message;
}

/**
 * FETCH and UID FETCH (RFC 9051 §6.4.5, §6.4.9). UID FETCH always sends
 * UID; a fetch that set `\Seen` sends FLAGS too. Modifiers (CHANGEDSINCE,
 * RFC 7162) are not supported yet.
 */
export const FETCH: Command = {
	phases: SELECTED,
	async run(context) {
		const { connection, cursor, uid } = context;
		const view = connection.state.selected as Selected;
		const positions = positionsOf(cursor, view, uid);
		cursor.sp();
		let items = fetchItems(cursor);
		if (cursor.take(' ')) cursor.fail('FETCH modifiers are not supported');
		cursor.end();
		if (uid && !items.some((item) => item.kind === 'UID'))
			items = [UID, ...items];
		for (const { position, uid: messageUid, message } of await loadMessages(
			connection,
			view,
			positions,
		)) {
			if (connection.closed) return;
			const now = await seen(connection, view, message, items);
			const changed =
				now !== message && !items.some((item) => item.kind === 'FLAGS');
			const pieces = await renderFetch(connection, view, {
				seq: position + 1,
				uid: messageUid,
				message: now,
				items: changed ? [...items, FLAGS] : items,
			});
			await connection.send(pieces);
		}
		await ok(context, `${uid ? 'UID ' : ''}FETCH completed`);
	},
};
