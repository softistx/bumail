import type { FlagChange } from '@bumail/store';
import { positionsOf } from '../mailbox/lookup';
import type { Selected } from '../mailbox/selected';
import { flagList } from '../mailbox/sync';
import type { Cursor } from '../protocol/cursor';
import { type Command, no, ok, SELECTED } from './context';

/** `FLAGS`, `+FLAGS` or `-FLAGS`, each with `.SILENT` or not (RFC 9051 §6.4.6). */
function action(cursor: Cursor): { op: '' | '+' | '-'; silent: boolean } {
	if (cursor.peek() === '(') cursor.fail('STORE modifiers are not supported');
	const op = cursor.take('+') ? '+' : cursor.take('-') ? '-' : '';
	const name = cursor.itemName().toUpperCase();
	if (name !== 'FLAGS' && name !== 'FLAGS.SILENT')
		cursor.fail(`Unknown STORE item ${name}`);
	return { op, silent: name === 'FLAGS.SILENT' };
}

/** A flag list, or flags separated by spaces. */
function flags(cursor: Cursor): string[] {
	if (cursor.peek() === '(') return cursor.list((c) => c.flag());
	const list = [cursor.flag()];
	while (cursor.take(' ')) list.push(cursor.flag());
	return list;
}

function changeOf(op: '' | '+' | '-', list: readonly string[]): FlagChange {
	if (op === '+') return { add: list };
	if (op === '-') return { remove: list };
	return { set: list };
}

/**
 * STORE and UID STORE (§6.4.6, §6.4.9): a FETCH FLAGS response for each
 * message unless `.SILENT`, with its UID for UID STORE. UNCHANGEDSINCE
 * (RFC 7162) is not supported yet.
 */
export const STORE: Command = {
	phases: SELECTED,
	async run(context) {
		const { connection, cursor, uid } = context;
		const view = connection.state.selected as Selected;
		const positions = positionsOf(cursor, view, uid);
		cursor.sp();
		const { op, silent } = action(cursor);
		cursor.sp();
		const list = flags(cursor);
		cursor.end();
		if (view.readOnly)
			return no(context, '[READ-ONLY] The mailbox is read-only');
		const ids = positions.map((position) => view.idAt(position));
		const result =
			ids.length === 0
				? { messages: [] }
				: await connection.settings.store.setFlags(
						connection.accountId,
						ids,
						changeOf(op, list),
					);
		const told = result.messages
			.map((message) => ({ message, uid: view.uidOf(message.id) }))
			.filter(
				(entry): entry is { message: typeof entry.message; uid: number } =>
					entry.uid !== undefined,
			)
			.sort((a, b) => a.uid - b.uid);
		for (const { message, uid: messageUid } of told) {
			view.setFlags(messageUid, message.flags);
			if (silent) continue;
			const seq = view.positionOf(messageUid) + 1;
			const uidPart = uid ? ` UID ${messageUid}` : '';
			await connection.untagged(
				`${seq} FETCH (FLAGS ${flagList(message.flags)}${uidPart})`,
			);
		}
		await ok(context, `${uid ? 'UID ' : ''}STORE completed`);
	},
};
