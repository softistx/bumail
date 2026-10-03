import type { Message } from '@bumail/store';
import type { Cursor } from '../protocol/cursor';
import {
	parseSequenceSet,
	seqPositions,
	uidPositions,
} from '../protocol/sequence';
import type { Connection } from '../server/connection';
import type { Selected } from './selected';

/** Past this many messages, one listing of the mailbox beats a lookup each. */
const LOOKUPS = 64;

/**
 * The positions a command's set names in the view: sequence numbers, or
 * UIDs for a UID command. A sequence number past the last message is BAD
 * (RFC 9051 §6.4.4); a UID that names no message is skipped.
 */
export function positionsOf(
	cursor: Cursor,
	view: Selected,
	uid: boolean,
): number[] {
	const set = parseSequenceSet(cursor.sequenceText());
	if (!set) return cursor.fail('Expected a sequence set');
	if (uid) return uidPositions(set, view.uids);
	return seqPositions(set, view.count) ?? cursor.fail('No such message');
}

/** A message of the view, as the store holds it now. */
export interface Loaded {
	readonly position: number;
	readonly uid: number;
	readonly message: Message;
}

/**
 * The messages at these positions, fresh from the store. A message that
 * left the mailbox since the client last heard is skipped: its EXPUNGE
 * comes at the next sync.
 */
export async function loadMessages(
	connection: Connection,
	view: Selected,
	positions: readonly number[],
): Promise<Loaded[]> {
	const { store } = connection.settings;
	const accountId = connection.accountId;
	if (positions.length === 0) return [];
	const byUid = new Map<number, Message>();
	if (positions.length <= LOOKUPS) {
		for (const position of positions) {
			const message = await store.getMessage(accountId, view.idAt(position));
			const uid = view.uidAt(position);
			const here = message?.mailboxes.some(
				(member) => member.mailboxId === view.mailboxId && member.uid === uid,
			);
			if (message && here) byUid.set(uid, message);
		}
	} else {
		const fromUid = view.uidAt(positions[0] as number);
		const entries = await store.listMessages(accountId, view.mailboxId, {
			fromUid,
		});
		for (const entry of entries) byUid.set(entry.uid, entry.message);
	}
	const loaded: Loaded[] = [];
	for (const position of positions) {
		const uid = view.uidAt(position);
		const message = byUid.get(uid);
		if (message) loaded.push({ position, uid, message });
	}
	return loaded;
}
