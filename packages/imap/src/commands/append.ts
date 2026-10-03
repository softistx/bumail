import { type Mailbox, normalizeFlag } from '@bumail/store';
import { sync } from '../mailbox/sync';
import { nameFromClient, Tree } from '../mailbox/tree';
import { Cursor, type Framed, SyntaxProblem } from '../protocol/cursor';
import { parseDateTime } from '../protocol/dates';
import { type Piece, tagged } from '../protocol/response';
import type { Connection } from '../server/connection';
import { answerFailure } from '../server/failure';
import { AUTHENTICATED, type Command, type Context } from './context';

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
		date = parseDateTime(text) ?? cursor.fail(`"${text}" is not a date-time`);
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

async function added(
	context: Pick<Context, 'connection' | 'tag'>,
	mailbox: Mailbox,
): Promise<void> {
	const { connection } = context;
	if (connection.state.selected?.mailboxId === mailbox.id)
		await sync(connection);
	await connection.send(tagged(context.tag, 'OK', 'APPEND completed'));
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
	return streamInto(connection, target, ready.mailbox, ready.flags, size);
}

function streamInto(
	connection: Connection,
	target: AppendTarget,
	mailbox: Mailbox,
	flags: string[],
	size: number,
): AppendStream {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let wake: (() => void) | undefined;
	let stopped = false;
	const stop = () => {
		stopped = true;
		wake?.();
	};
	const content = new ReadableStream<Uint8Array>(
		{
			start: (c) => {
				controller = c;
			},
			pull: () => wake?.(),
			cancel: stop,
		},
		new ByteLengthQueuingStrategy({
			highWaterMark: Math.min(size, 64 * 1024) || 1,
		}),
	);
	const adding = connection.settings.store.addMessage(
		connection.accountId,
		mailbox.id,
		{
			content,
			flags,
			...(target.date ? { receivedAt: target.date } : {}),
		},
	);
	adding.catch(stop);
	return {
		async write(bytes) {
			if (stopped) return;
			controller.enqueue(bytes);
			if ((controller.desiredSize ?? 1) > 0) return;
			await new Promise<void>((resolve) => (wake = resolve));
			wake = undefined;
		},
		async finish(rest) {
			const context = { connection, tag: target.tag };
			if (rest !== '') {
				error(controller, 'Unexpected text after the message');
				await adding.catch(() => undefined);
				return connection.send(
					tagged(target.tag, 'BAD', 'Unexpected text after the message'),
				);
			}
			if (!stopped) controller.close();
			try {
				await adding;
			} catch (failure) {
				return answerFailure(connection, target.tag, failure);
			}
			await added(context, mailbox);
		},
		abort() {
			error(controller, 'The connection closed');
			stop();
		},
	};
}

function error(
	controller: ReadableStreamDefaultController<Uint8Array>,
	message: string,
): void {
	try {
		controller.error(new Error(message));
	} catch {
		// Already closed or errored.
	}
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
