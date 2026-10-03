import type { Mailbox } from '@bumail/store';
import { nameForClient, nameFromClient, Tree } from '../mailbox/tree';
import type { Cursor } from '../protocol/cursor';
import { type Piece, Response } from '../protocol/response';
import type { Connection } from '../server/connection';
import { AUTHENTICATED, type Command, no, ok } from './context';

/** The STATUS items answered (RFC 9051 §6.3.11); RECENT, always 0, for IMAP4rev1. */
const ITEMS = new Set([
	'MESSAGES',
	'UIDNEXT',
	'UIDVALIDITY',
	'UNSEEN',
	'SIZE',
	'DELETED',
	'RECENT',
]);

/** A parenthesised list of STATUS items, upper case; an unknown one is BAD. */
export function statusItems(cursor: Cursor): string[] {
	const items = cursor.list((c) => c.atom('a STATUS item').toUpperCase());
	for (const item of items)
		if (!ITEMS.has(item)) cursor.fail(`Unknown STATUS item ${item}`);
	if (items.length === 0) cursor.fail('STATUS needs at least one item');
	return items;
}

/** SIZE and DELETED read the mailbox's messages; the rest its counters. */
async function tally(
	connection: Connection,
	mailbox: Mailbox,
	items: readonly string[],
): Promise<{ size: number; deleted: number }> {
	if (!items.includes('SIZE') && !items.includes('DELETED'))
		return { size: 0, deleted: 0 };
	const entries = await connection.settings.store.listMessages(
		connection.accountId,
		mailbox.id,
	);
	let size = 0;
	let deleted = 0;
	for (const { message } of entries) {
		size += message.size;
		if (message.flags.includes('\\Deleted')) deleted++;
	}
	return { size, deleted };
}

/** `* STATUS name (ITEM n …)`. */
export async function statusResponse(
	connection: Connection,
	mailbox: Mailbox,
	path: string,
	items: readonly string[],
): Promise<Piece[]> {
	const { size, deleted } = await tally(connection, mailbox, items);
	const values: Record<string, number> = {
		MESSAGES: mailbox.messages,
		UIDNEXT: mailbox.uidNext,
		UIDVALIDITY: mailbox.uidValidity,
		UNSEEN: mailbox.unseen,
		SIZE: size,
		DELETED: deleted,
		RECENT: 0,
	};
	const pairs = items.map((item) => `${item} ${values[item]}`).join(' ');
	return new Response()
		.text('* STATUS ')
		.astring(nameForClient(connection, path))
		.text(` (${pairs})`)
		.done();
}

/** STATUS (§6.3.11). */
export const STATUS: Command = {
	phases: AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		const name = nameFromClient(connection, cursor.astring());
		cursor.sp();
		const items = statusItems(cursor);
		cursor.end();
		const tree = await Tree.load(connection);
		const mailbox = tree.find(name);
		if (!mailbox) return no(context, '[NONEXISTENT] No such mailbox');
		await connection.send(
			await statusResponse(connection, mailbox, tree.pathOf(mailbox), items),
		);
		await ok(context, 'STATUS completed');
	},
};
