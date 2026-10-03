import type { Mailbox, MailboxEntry } from '@bumail/store';
import { Selected } from '../mailbox/selected';
import { flagList } from '../mailbox/sync';
import {
	DELIMITER,
	nameForClient,
	nameFromClient,
	Tree,
} from '../mailbox/tree';
import { Response } from '../protocol/response';
import type { Connection } from '../server/connection';
import {
	AUTHENTICATED,
	type Command,
	type Context,
	no,
	ok,
	SELECTED,
} from './context';
import { expungeDeleted } from './expunge';

const SYSTEM = ['\\Answered', '\\Flagged', '\\Deleted', '\\Seen', '\\Draft'];

/**
 * The system flags, and every keyword a message of the mailbox has, once
 * whatever its case (RFC 9051 §2.3.2): in the case the first message that
 * has it stored, as a client that set `$Forwarded` looks for it.
 */
function flagsInUse(entries: readonly MailboxEntry[]): string[] {
	const keywords = new Map<string, string>();
	for (const { message } of entries) {
		for (const flag of message.flags) {
			const key = flag.toLowerCase();
			if (!flag.startsWith('\\') && !keywords.has(key)) keywords.set(key, flag);
		}
	}
	const sorted = [...keywords.keys()].sort();
	return [...SYSTEM, ...sorted.map((key) => keywords.get(key) as string)];
}

/** The untagged responses SELECT and EXAMINE give (RFC 9051 §6.3.2; RFC 3501 §6.3.1 for IMAP4rev1). */
async function describe(
	connection: Connection,
	mailbox: Mailbox,
	path: string,
	entries: readonly MailboxEntry[],
	readOnly: boolean,
): Promise<void> {
	const flags = flagsInUse(entries);
	const lines = [`${entries.length} EXISTS`];
	if (!connection.state.rev2) {
		lines.push('0 RECENT');
		// RFC 3501 §6.3.1: the first unseen message; IMAP4rev2 dropped it.
		const unseen = entries.findIndex(
			({ message }) => !message.flags.includes('\\Seen'),
		);
		if (unseen >= 0)
			lines.push(
				`OK [UNSEEN ${unseen + 1}] Message ${unseen + 1} is first unseen`,
			);
	}
	lines.push(
		`OK [UIDVALIDITY ${mailbox.uidValidity}] UIDs valid`,
		`OK [UIDNEXT ${mailbox.uidNext}] Predicted next UID`,
		`FLAGS ${flagList(flags)}`,
		`OK [PERMANENTFLAGS ${readOnly ? '()' : flagList([...flags, '\\*'])}] Flags permitted`,
	);
	for (const line of lines) await connection.untagged(line);
	if (connection.state.rev2) {
		const list = new Response().text(`* LIST () "${DELIMITER}" `);
		await connection.send(list.astring(nameForClient(connection, path)).done());
	}
}

/** Leaves the selected mailbox, if any; `CLOSED` tells an IMAP4rev2 client (§7.1). */
async function deselect(connection: Connection): Promise<void> {
	if (!connection.state.selected) return;
	connection.state.selected = undefined;
	connection.state.phase = 'authenticated';
	if (connection.state.rev2) {
		await connection.untagged('OK [CLOSED] Previous mailbox is now closed');
	}
}

async function open(context: Context, readOnly: boolean): Promise<void> {
	const { connection, cursor } = context;
	const name = nameFromClient(connection, cursor.astring());
	if (cursor.take(' '))
		cursor.fail(`${context.name} parameters are not supported`);
	cursor.end();
	await deselect(connection);
	const tree = await Tree.load(connection);
	const mailbox = tree.find(name);
	if (!mailbox) return no(context, '[NONEXISTENT] No such mailbox');
	const entries = await connection.settings.store.listMessages(
		connection.accountId,
		mailbox.id,
	);
	await describe(connection, mailbox, tree.pathOf(mailbox), entries, readOnly);
	connection.state.selected = new Selected(mailbox, entries, readOnly);
	connection.state.phase = 'selected';
	const mode = readOnly ? 'READ-ONLY' : 'READ-WRITE';
	await ok(context, `[${mode}] ${context.name} completed`);
}

/** SELECT (§6.3.2). */
export const SELECT: Command = {
	phases: AUTHENTICATED,
	run: (context) => open(context, false),
};

/** EXAMINE (§6.3.3): SELECT, read-only. */
export const EXAMINE: Command = {
	phases: AUTHENTICATED,
	run: (context) => open(context, true),
};

/** CLOSE (§6.4.1): `\Deleted` messages are removed, silently, unless read-only. */
export const CLOSE: Command = {
	phases: SELECTED,
	bare: true,
	async run(context) {
		const { connection } = context;
		const view = connection.state.selected as Selected;
		connection.state.selected = undefined;
		connection.state.phase = 'authenticated';
		if (!view.readOnly) await expungeDeleted(connection, view, false);
		await ok(context, 'CLOSE completed');
	},
};

/** UNSELECT (RFC 3691, §6.4.2): CLOSE without removing anything. */
export const UNSELECT: Command = {
	phases: SELECTED,
	bare: true,
	async run(context) {
		context.connection.state.selected = undefined;
		context.connection.state.phase = 'authenticated';
		await ok(context, 'UNSELECT completed');
	},
};
