import type { Mailbox } from '@bumail/store';
import { canonical, DELIMITER, nameFromClient, Tree } from '../mailbox/tree';
import { echo } from '../protocol/echo';
import type { Connection } from '../server/connection';
import { AUTHENTICATED, type Command, type Context, no, ok } from './context';

/** A name a mailbox is to have: one trailing delimiter dropped (§6.3.4), no empty level. */
function newPath(context: Context, raw: string): string {
	const name = nameFromClient(context.connection, raw);
	const path = name.endsWith(DELIMITER) ? name.slice(0, -1) : name;
	if (path.split(DELIMITER).some((level) => level === '')) {
		context.cursor.fail(`"${echo(raw)}" has an empty level`);
	}
	return canonical(path);
}

/** The levels a mailbox name may have: each one costs every later look at the tree. */
export const MAX_LEVELS = 32;

/** The longest mailbox name taken, every level and delimiter counted. */
export const MAX_NAME = 1024;

/**
 * The longest level taken: the store's own bound on a mailbox name. Checked
 * here, before any missing parent is created, so a refused CREATE or
 * RENAME leaves nothing behind.
 */
export const MAX_LEVEL = 255;

/** Whether a level holds a control character: the store keeps none in a name. */
function hasControl(level: string): boolean {
	for (let i = 0; i < level.length; i++) {
		const code = level.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Why the store would refuse a new path, if it would: a `NO` text. It
 * mirrors the store's own checks on a mailbox name (each level trimmed and
 * not empty, at most 255 characters, no control character) and is run
 * before any missing parent is created, so a refused CREATE or RENAME
 * leaves nothing behind. A level with white space at either end would be
 * kept trimmed, under another name than the client asked for.
 */
function refusal(path: string): string | undefined {
	if (path.length > MAX_NAME)
		return `[LIMIT] A mailbox name is at most ${MAX_NAME} characters`;
	const levels = path.split(DELIMITER);
	if (levels.length > MAX_LEVELS)
		return `[LIMIT] A mailbox name has at most ${MAX_LEVELS} levels`;
	if (levels.some((level) => level.length > MAX_LEVEL))
		return `[LIMIT] A level of a mailbox name is at most ${MAX_LEVEL} characters`;
	if (levels.some((level) => level.trim() !== level))
		return '[CANNOT] A level of a mailbox name cannot begin or end with white space';
	if (levels.some(hasControl))
		return '[CANNOT] A mailbox name cannot hold a control character';
	return undefined;
}

/** The parent a new path goes under, creating each missing level (RFC 9051 §6.3.4). */
async function parentOf(
	connection: Connection,
	tree: Tree,
	path: string,
): Promise<Mailbox | undefined> {
	const levels = path.split(DELIMITER).slice(0, -1);
	let parent: Mailbox | undefined;
	let prefix = '';
	for (const level of levels) {
		prefix = prefix === '' ? level : `${prefix}${DELIMITER}${level}`;
		parent =
			tree.find(prefix) ??
			(await connection.settings.store.createMailbox(connection.accountId, {
				name: level,
				...(parent ? { parentId: parent.id } : {}),
			}));
	}
	return parent;
}

function lastLevel(path: string): string {
	return path.slice(path.lastIndexOf(DELIMITER) + 1);
}

/** CREATE (§6.3.4). */
export const CREATE: Command = {
	phases: AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		const path = newPath(context, cursor.astring());
		if (cursor.take(' ')) cursor.fail('CREATE parameters are not supported');
		cursor.end();
		const refused = refusal(path);
		if (refused) return no(context, refused);
		const tree = await Tree.load(connection);
		if (tree.find(path))
			return no(context, '[ALREADYEXISTS] The mailbox already exists');
		const parent = await parentOf(connection, tree, path);
		await connection.settings.store.createMailbox(connection.accountId, {
			name: lastLevel(path),
			...(parent ? { parentId: parent.id } : {}),
		});
		await ok(context, 'CREATE completed');
	},
};

/** DELETE (§6.3.5): its messages go with it. INBOX, a parent, and the selected mailbox stay. */
export const DELETE: Command = {
	phases: AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		const name = nameFromClient(connection, cursor.astring());
		cursor.end();
		const tree = await Tree.load(connection);
		const mailbox = tree.find(name);
		if (!mailbox) return no(context, '[NONEXISTENT] No such mailbox');
		if (mailbox.role === 'inbox' || canonical(name) === 'INBOX') {
			return no(context, '[CANNOT] INBOX cannot be deleted');
		}
		if (tree.hasChildren(mailbox)) {
			return no(context, '[CANNOT] Delete the mailboxes inside it first');
		}
		if (connection.state.selected?.mailboxId === mailbox.id) {
			return no(context, '[INUSE] The mailbox is selected: close it first');
		}
		await connection.settings.store.deleteMailbox(
			connection.accountId,
			mailbox.id,
			{
				removeMessages: true,
			},
		);
		await ok(context, 'DELETE completed');
	},
};

/** RENAME (§6.3.6), the missing levels of the new name created. Not INBOX. */
export const RENAME: Command = {
	phases: AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		const from = nameFromClient(connection, cursor.astring());
		cursor.sp();
		const to = newPath(context, cursor.astring());
		cursor.end();
		const refused = refusal(to);
		if (refused) return no(context, refused);
		const tree = await Tree.load(connection);
		const mailbox = tree.find(from);
		if (!mailbox) return no(context, '[NONEXISTENT] No such mailbox');
		if (canonical(from) === 'INBOX') {
			return no(context, '[CANNOT] Renaming INBOX is not supported');
		}
		if (tree.find(to))
			return no(context, '[ALREADYEXISTS] The new name is taken');
		if (`${to}${DELIMITER}`.startsWith(`${tree.pathOf(mailbox)}${DELIMITER}`)) {
			return no(context, '[CANNOT] A mailbox cannot move inside itself');
		}
		const parent = await parentOf(connection, tree, to);
		await connection.settings.store.renameMailbox(
			connection.accountId,
			mailbox.id,
			{
				name: lastLevel(to),
				parentId: parent?.id ?? null,
			},
		);
		await ok(context, 'RENAME completed');
	},
};

async function subscription(
	context: Context,
	subscribed: boolean,
): Promise<void> {
	const { connection, cursor } = context;
	const name = nameFromClient(connection, cursor.astring());
	cursor.end();
	const mailbox = (await Tree.load(connection)).find(name);
	if (!mailbox) return no(context, '[NONEXISTENT] No such mailbox');
	await connection.settings.store.setSubscribed(
		connection.accountId,
		mailbox.id,
		subscribed,
	);
	await ok(context, `${context.name} completed`);
}

/** SUBSCRIBE (§6.3.7): only an existing mailbox, since the store keeps no other name. */
export const SUBSCRIBE: Command = {
	phases: AUTHENTICATED,
	run: (context) => subscription(context, true),
};

/** UNSUBSCRIBE (§6.3.8). */
export const UNSUBSCRIBE: Command = {
	phases: AUTHENTICATED,
	run: (context) => subscription(context, false),
};
