import { type Mailbox, normalizeFlag } from '@bumail/store';
import { nameFromClient, Tree } from '../mailbox/tree';
import { Cursor, type Framed, SyntaxProblem } from '../protocol/cursor';
import { parseDateTime } from '../protocol/dates';
import { echo } from '../protocol/echo';
import { type Piece, tagged } from '../protocol/response';
import type { Connection } from '../server/connection';
import { AUTHENTICATED, type Command } from './context';
import { added, Inflow } from './inflow';

/** What an APPEND says before its message (RFC 9051 §6.3.12). */
export interface AppendTarget {
	readonly tag: string;
	readonly mailbox: string;
	readonly flags: readonly string[];
	readonly date?: Date;
}

/** An APPEND whose message streams into the store as it is read. */
export interface AppendStream {
	/** Bytes of the message; resolves when the store can take more. */
	write(bytes: Uint8Array): Promise<void>;
	/** The rest of the line after the message ends the command: empty, or BAD. */
	finish(rest: string): Promise<void>;
	/** The connection closed: nothing is kept. */
	abort(): void;
}

/** `mailbox [flags] [date-time]`, the cursor left on the message. */
function head(cursor: Cursor): Omit<AppendTarget, 'tag'> {
	const mailbox = cursor.astring();
	cursor.sp();
	let flags: string[] = [];
	if (cursor.peek() === '(') {
		flags = cursor.list((c) => c.flag());
		cursor.sp();
	}
	let date: Date | undefined;
	if (cursor.peek() === '"') {
		const text = cursor.string();
		date =
			parseDateTime(text) ?? cursor.fail(`"${echo(text)}" is not a date-time`);
		cursor.sp();
	}
	return { mailbox, flags, ...(date ? { date } : {}) };
}

/** The APPEND a command so far is, when the literal just announced is its message. */
export function appendTarget(framed: Framed): AppendTarget | undefined {
	try {
		const cursor = new Cursor(framed);
		const tag = cursor.astringAtom();
		if (!tag || !cursor.take(' ') || cursor.atom().toUpperCase() !== 'APPEND')
			return undefined;
		cursor.sp();
		const target = head(cursor);
		return cursor.restIsPendingLiteral() ? { tag, ...target } : undefined;
	} catch {
		return undefined;
	}
}

interface Refusal {
	readonly status: 'NO' | 'BAD';
	readonly text: string;
}

/** The mailbox and flags of an APPEND, checked; a refusal otherwise. */
async function prepare(
	connection: Connection,
	target: Omit<AppendTarget, 'tag'>,
): Promise<{ mailbox: Mailbox; flags: string[] } | { refusal: Refusal }> {
	let flags: string[];
	try {
		flags = target.flags.map(normalizeFlag);
	} catch {
		return { refusal: { status: 'BAD', text: 'Invalid flag' } };
	}
	const name = nameFromClient(connection, target.mailbox);
	const mailbox = (await Tree.load(connection)).find(name);
	if (!mailbox)
		return { refusal: { status: 'NO', text: '[TRYCREATE] No such mailbox' } };
	return { mailbox, flags };
}

/**
 * Starts an APPEND before its message is read: the mailbox is checked, so
 * a synchronising literal can be refused before the client sends it, then
 * `addMessage` reads the message as a stream while it arrives.
 */
export async function beginAppend(
	connection: Connection,
	target: AppendTarget,
	size: number,
): Promise<AppendStream | { refusal: Piece[] }> {
	let ready: Awaited<ReturnType<typeof prepare>>;
	try {
		ready = await prepare(connection, target);
	} catch (error) {
		if (error instanceof SyntaxProblem)
			return { refusal: tagged(target.tag, 'BAD', error.message) };
		throw error;
	}
	if ('refusal' in ready) {
		return {
			refusal: tagged(target.tag, ready.refusal.status, ready.refusal.text),
		};
	}
	return new Inflow(connection, target, ready.mailbox, ready.flags, size);
}

/**
 * APPEND (§6.3.12) whose message came as a kept literal: when the line did
 * not read as an APPEND before its literal, so that it was not streamed.
 */
export const APPEND: Command = {
	phases: AUTHENTICATED,
	async run(context) {
		const { connection, cursor } = context;
		const target = head(cursor);
		const content = cursor.stringBytes();
		cursor.end();
		const ready = await prepare(connection, target);
		if ('refusal' in ready) {
			return connection.send(
				tagged(context.tag, ready.refusal.status, ready.refusal.text),
			);
		}
		await connection.settings.store.addMessage(
			connection.accountId,
			ready.mailbox.id,
			{
				content,
				flags: ready.flags,
				...(target.date ? { receivedAt: target.date } : {}),
			},
		);
		await added(context, ready.mailbox);
	},
};
