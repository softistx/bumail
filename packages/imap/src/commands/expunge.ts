import type { Selected } from '../mailbox/selected';
import { sync } from '../mailbox/sync';
import { parseSequenceSet, uidPositions } from '../protocol/sequence';
import type { Connection } from '../server/connection';
import { type Command, type Context, no, ok, SELECTED } from './context';

/**
 * Removes the messages of the selected mailbox that have `\Deleted` now,
 * as the store holds them, among `only` when given (UID EXPUNGE). With
 * `tell`, an EXPUNGE response for each, numbered as RFC 9051 §7.5.1 asks.
 */
export async function expungeDeleted(
	connection: Connection,
	view: Selected,
	tell: boolean,
	only?: ReadonlySet<number>,
): Promise<void> {
	const { store } = connection.settings;
	const entries = await store.listMessages(
		connection.accountId,
		view.mailboxId,
	);
	const victims = entries.filter(
		({ uid, message }) =>
			message.flags.includes('\\Deleted') &&
			view.positionOf(uid) >= 0 &&
			(only === undefined || only.has(uid)),
	);
	if (victims.length === 0) return;
	const result = await store.removeMessages(
		connection.accountId,
		victims.map((entry) => entry.message.id),
		view.mailboxId,
	);
	const uids = result.expunged
		.filter((entry) => entry.mailboxId === view.mailboxId)
		.map((entry) => entry.uid);
	const seqs = view.expunge(uids);
	if (tell) for (const seq of seqs) await connection.untagged(`${seq} EXPUNGE`);
}

async function run(
	context: Context,
	only?: ReadonlySet<number>,
): Promise<void> {
	const { connection } = context;
	const view = connection.state.selected as Selected;
	if (view.readOnly) return no(context, '[READ-ONLY] The mailbox is read-only');
	await sync(connection);
	if (connection.closed) return;
	await expungeDeleted(connection, view, true, only);
	await ok(context, `${context.uid ? 'UID ' : ''}EXPUNGE completed`);
}

/** EXPUNGE (RFC 9051 §6.4.3). */
export const EXPUNGE: Command = {
	phases: SELECTED,
	bare: true,
	run: (context) => run(context),
};

/** UID EXPUNGE (§6.4.9): only the messages of the set. */
export const UID_EXPUNGE: Command = {
	phases: SELECTED,
	async run(context) {
		const { connection, cursor } = context;
		const set =
			parseSequenceSet(cursor.sequenceText()) ??
			cursor.fail('Expected a UID set');
		cursor.end();
		const view = connection.state.selected as Selected;
		const only = new Set(
			uidPositions(set, view.uids).map((at) => view.uidAt(at)),
		);
		await run(context, only);
	},
};
