import type { Mailbox } from '@bumail/store';
import { MAX_PATTERN, matcher } from '../mailbox/pattern';
import {
	DELIMITER,
	nameForClient,
	nameFromClient,
	specialUse,
	Tree,
} from '../mailbox/tree';
import type { Cursor } from '../protocol/cursor';
import { Response } from '../protocol/response';
import type { Connection } from '../server/connection';
import { AUTHENTICATED, type Command, type Context, ok } from './context';
import { statusItems, statusResponse } from './status';

/** What LIST was asked (RFC 9051 §6.3.9, RFC 5258, RFC 6154). */
interface Query {
	readonly patterns: readonly string[];
	readonly subscribedOnly: boolean;
	readonly recursive: boolean;
	readonly specialOnly: boolean;
	readonly returnSubscribed: boolean;
	readonly status?: readonly string[];
	/** LSUB (IMAP4rev1): subscribed mailboxes, as LSUB responses. */
	readonly lsub: boolean;
}

function selection(cursor: Cursor): Set<string> {
	const options = new Set(
		cursor.list((c) => c.atom('a selection option').toUpperCase()),
	);
	for (const option of options) {
		if (
			!['SUBSCRIBED', 'REMOTE', 'RECURSIVEMATCH', 'SPECIAL-USE'].includes(
				option,
			)
		) {
			cursor.fail(`Unknown LIST selection option ${option}`);
		}
	}
	if (options.has('RECURSIVEMATCH') && options.size === 1) {
		cursor.fail('RECURSIVEMATCH needs another selection option (RFC 5258 §3)');
	}
	return options;
}

function returning(cursor: Cursor): { subscribed: boolean; status?: string[] } {
	let subscribed = false;
	let status: string[] | undefined;
	cursor.list((c) => {
		const option = c.atom('a return option').toUpperCase();
		if (option === 'STATUS') {
			c.sp();
			status = statusItems(c);
		} else if (option === 'SUBSCRIBED') subscribed = true;
		else if (option !== 'CHILDREN' && option !== 'SPECIAL-USE') {
			c.fail(`Unknown LIST return option ${option}`);
		}
	});
	return { subscribed, ...(status ? { status } : {}) };
}

function parse(context: Context, lsub: boolean): Query {
	const { connection, cursor } = context;
	let selected = new Set<string>();
	if (!lsub && cursor.peek() === '(') {
		selected = selection(cursor);
		cursor.sp();
	}
	const reference = nameFromClient(connection, cursor.astring());
	cursor.sp();
	const raw =
		!lsub && cursor.peek() === '('
			? cursor.list((c) => c.listMailbox())
			: [cursor.listMailbox()];
	let back: ReturnType<typeof returning> | undefined;
	if (!lsub && cursor.take(' ')) {
		if (cursor.atom('RETURN').toUpperCase() !== 'RETURN')
			cursor.fail('Expected RETURN');
		cursor.sp();
		back = returning(cursor);
	}
	cursor.end();
	const patterns = raw.map((pattern) => {
		const full = `${reference}${nameFromClient(connection, pattern)}`;
		if (full.length > MAX_PATTERN) cursor.fail('The pattern is too long');
		return full;
	});
	return {
		patterns,
		subscribedOnly: lsub || selected.has('SUBSCRIBED'),
		recursive: selected.has('RECURSIVEMATCH'),
		specialOnly: selected.has('SPECIAL-USE'),
		returnSubscribed: selected.has('SUBSCRIBED') || (back?.subscribed ?? false),
		...(back?.status ? { status: back.status } : {}),
		lsub,
	};
}

function attributes(
	tree: Tree,
	mailbox: Mailbox,
	query: Query,
	listed: boolean,
): string[] {
	const list = [
		tree.hasChildren(mailbox) ? '\\HasChildren' : '\\HasNoChildren',
	];
	const special = specialUse(mailbox);
	if (special) list.push(special);
	if (query.returnSubscribed && !query.lsub && mailbox.isSubscribed && listed)
		list.push('\\Subscribed');
	return list;
}

/** Whether a mailbox is listed, or only named for a subscribed child (RECURSIVEMATCH, RFC 5258 §3.5). */
function verdict(
	tree: Tree,
	mailbox: Mailbox,
	query: Query,
): 'listed' | 'childinfo' | undefined {
	if (query.specialOnly && !specialUse(mailbox)) return undefined;
	if (!query.subscribedOnly || mailbox.isSubscribed) return 'listed';
	if (
		query.recursive &&
		tree.descendants(mailbox).some((child) => child.isSubscribed)
	) {
		return 'childinfo';
	}
	return undefined;
}

async function list(context: Context, lsub: boolean): Promise<void> {
	const { connection } = context;
	const query = parse(context, lsub);
	const verb = lsub ? 'LSUB' : 'LIST';
	if (query.patterns.length === 1 && query.patterns[0] === '') {
		await connection.untagged(`${verb} (\\Noselect) "${DELIMITER}" ""`);
		return ok(context, `${verb} completed`);
	}
	const tree = await Tree.load(connection);
	const matches = query.patterns.map(matcher);
	// INBOX first, then the others by name.
	const key = (mailbox: Mailbox) => {
		const path = tree.pathOf(mailbox);
		return path === 'INBOX' || path.startsWith('INBOX/') ? `\0${path}` : path;
	};
	const mailboxes = [...tree.mailboxes].sort((a, b) =>
		key(a) < key(b) ? -1 : 1,
	);
	for (const mailbox of mailboxes) {
		const path = tree.pathOf(mailbox);
		if (!matches.some((match) => match(path))) continue;
		const found = verdict(tree, mailbox, query);
		if (!found) continue;
		await send(
			connection,
			verb,
			path,
			attributes(tree, mailbox, query, found === 'listed'),
			found,
		);
		if (query.status && found === 'listed') {
			await connection.send(
				await statusResponse(connection, mailbox, path, query.status),
			);
		}
	}
	await ok(context, `${verb} completed`);
}

function send(
	connection: Connection,
	verb: string,
	path: string,
	attributes: readonly string[],
	found: 'listed' | 'childinfo',
): Promise<void> {
	const line = new Response()
		.text(`* ${verb} (${attributes.join(' ')}) "${DELIMITER}" `)
		.astring(nameForClient(connection, path));
	if (found === 'childinfo') line.text(' ("CHILDINFO" ("SUBSCRIBED"))');
	return connection.send(line.done());
}

/** LIST (RFC 9051 §6.3.9), with LIST-EXTENDED's options (RFC 5258) and SPECIAL-USE (RFC 6154). */
export const LIST: Command = {
	phases: AUTHENTICATED,
	run: (context) => list(context, false),
};

/** LSUB (RFC 3501 §6.3.9), for IMAP4rev1 clients. */
export const LSUB: Command = {
	phases: AUTHENTICATED,
	run: (context) => list(context, true),
};
