import { positionsOf } from '../mailbox/lookup';
import type { Selected } from '../mailbox/selected';
import { sync } from '../mailbox/sync';
import { nameFromClient, Tree } from '../mailbox/tree';
import { type Command, type Context, no, ok, SELECTED } from './context';

async function transfer(context: Context, move: boolean): Promise<void> {
	const { connection, cursor, uid } = context;
	const view = connection.state.selected as Selected;
	const positions = positionsOf(cursor, view, uid);
	cursor.sp();
	const name = nameFromClient(connection, cursor.astring());
	cursor.end();
	const verb = `${uid ? 'UID ' : ''}${context.name}`;
	if (move && view.readOnly)
		return no(context, '[READ-ONLY] The mailbox is read-only');
	const target = (await Tree.load(connection)).find(name);
	if (!target) return no(context, '[TRYCREATE] No such mailbox');
	if (move && target.id === view.mailboxId) {
		return no(context, '[CANNOT] The messages are already in this mailbox');
	}
	const ids = positions.map((position) => view.idAt(position));
	if (ids.length === 0) return ok(context, `${verb} completed`);
	const { store } = connection.settings;
	if (!move) {
		await store.copyMessages(connection.accountId, ids, target.id);
		if (target.id === view.mailboxId) await sync(connection);
		return ok(context, `${verb} completed`);
	}
	const result = await store.moveMessages(
		connection.accountId,
		ids,
		view.mailboxId,
		target.id,
	);
	const gone = result.messages
		.map((message) => view.uidOf(message.id))
		.filter((messageUid): messageUid is number => messageUid !== undefined);
	for (const seq of view.expunge(gone))
		await connection.untagged(`${seq} EXPUNGE`);
	await ok(context, `${verb} completed`);
}

/** COPY and UID COPY (RFC 9051 §6.4.7). */
export const COPY: Command = {
	phases: SELECTED,
	run: (context) => transfer(context, false),
};

/**
 * MOVE and UID MOVE (RFC 6851, RFC 9051 §6.4.8): the messages leave the
 * selected mailbox, each with an EXPUNGE response, keeping their ids.
 */
export const MOVE: Command = {
	phases: SELECTED,
	run: (context) => transfer(context, true),
};
