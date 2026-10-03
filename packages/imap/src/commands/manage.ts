import type { Mailbox } from '@bumail/store';
import { canonical, DELIMITER, nameFromClient, Tree } from '../mailbox/tree';
import type { Connection } from '../server/connection';
import { AUTHENTICATED, type Command, type Context, no, ok } from './context';

/** A name a mailbox is to have: one trailing delimiter dropped (§6.3.4), no empty level. */
function newPath(context: Context, raw: string): string {
	const name = nameFromClient(context.connection, raw);
	const path = name.endsWith(DELIMITER) ? name.slice(0, -1) : name;
	if (path.split(DELIMITER).some((level) => level === '')) {
		context.cursor.fail(`"${raw}" has an empty level`);
	}
	return canonical(path);
}

/** The parent a new path goes under, creating each missing level (RFC 9051 §6.3.4). */
async function parentOf(
	connection: Connection,
	tree: Tree,
	path: string,
): Promise<Mailbox | undefined> {
	const levels = path.split(DELIMITER).slice(0, -1);
	let parent: Mailbox | undefined;
	for (let depth = 1; depth <= levels.length; depth++) {
		const prefix = levels.slice(0, depth).join(DELIMITER);
		parent =
			tree.find(prefix) ??
			(await connection.settings.store.createMailbox(connection.accountId, {
				name: levels[depth - 1] as string,
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
