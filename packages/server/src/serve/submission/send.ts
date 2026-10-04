import { QueueError } from '@bumail/queue';
import type { ReceivedMessage, Reply, Session } from '@bumail/smtp';
import { joinHeader, returnPath, stripForged } from '../header';
import { deliver } from '../mx/deliver';
import { HEADER_TOO_LARGE, NOT_TAKEN, SPOOL_FULL } from '../mx/replies';
import { envelopeDomain, POSTMASTER, usersOf } from '../recipients';
import { type Spooled, spooledStream } from '../spool';
import type { SubmissionContext } from './index';
import {
	FROM_COUNT,
	FROM_NO_ADDRESS,
	FROM_NOT_YOURS,
	QUEUE_FULL,
	QUEUE_TOO_BIG,
	QUEUE_TOO_MANY,
} from './replies';
import { fromAddresses, fromIsYours } from './sender';

/** What a session keeps from MAIL FROM: the user, as the directory keeps it. */
export const USER = 'bumail.user';

/** How the log says why a From field was refused. */
const FROM_PROBLEMS = {
	count: 'it has no From field, or several',
	none: 'its From field names no address',
	no: 'its From field names another address',
} as const;

/** What a refusal of the queue's answers the client. */
function queueRefusal(error: QueueError): Reply | undefined {
	if (error.code === 'QUEUE_FULL') return QUEUE_FULL;
	if (error.code === 'MESSAGE_TOO_BIG') return QUEUE_TOO_BIG;
	if (error.code === 'TOO_MANY_RECIPIENTS') return QUEUE_TOO_MANY;
	return undefined;
}

/**
 * A submitted message, spooled, checked, signed, then handed on: to the
 * store for the hosted domains' recipients first, then to the queue for
 * the others, last, since a queued message may leave at once and cannot
 * be taken back. A failure answers the client to send the message again:
 * a local recipient the store already took keeps it, as on the MX, and
 * the retry may bring it a second copy; nothing ever leaves twice.
 */
export async function send(
	ctx: SubmissionContext,
	name: string,
	message: ReceivedMessage,
	session: Session,
): Promise<Reply | undefined> {
	let spooled: Spooled;
	try {
		const written = await ctx.spool.write(message.id, message.content);
		if (written === 'full') {
			ctx.log(
				`${name}: ${message.id} from ${session.remoteAddress} deferred: the spool is full`,
			);
			return SPOOL_FULL;
		}
		spooled = written;
	} catch (error) {
		if (!message.signal.aborted) {
			ctx.log(
				`${name}: ${message.id} from ${session.remoteAddress} not spooled: ${ctx.describe(error)}`,
			);
		}
		return NOT_TAKEN;
	}
	try {
		return await handOn(ctx, name, message, session, spooled);
	} finally {
		await spooled.remove();
	}
}

/** What a message is handed on as, once checked and signed. */
interface Outgoing {
	readonly ctx: SubmissionContext;
	readonly name: string;
	readonly message: ReceivedMessage;
	readonly spooled: Spooled;
	/** `<id> from <user> <<sender>>`, for the log. */
	readonly from: string;
	/** The header kept, forged fields removed. */
	readonly kept: readonly Uint8Array[];
	/** The `DKIM-Signature` field, if the From domain has a key. */
	readonly signature: string | undefined;
}

async function handOn(
	ctx: SubmissionContext,
	name: string,
	message: ReceivedMessage,
	session: Session,
	spooled: Spooled,
): Promise<Reply | undefined> {
	const { envelope } = message;
	const user = String(session.data[USER]);
	const from = `${message.id} from ${user} <${envelope.from}>`;
	const { header } = spooled;
	if (header === undefined) {
		ctx.log(`${name}: ${from} refused: its header is over 256 KiB`);
		return HEADER_TOO_LARGE;
	}
	const refusal = checkFrom(ctx, name, from, user, header);
	if (refusal !== undefined) return refusal;
	const out = await signed({ ctx, name, message, spooled, from }, header);

	const { directory } = ctx;
	const local = envelope.to.filter(
		(to) => to === POSTMASTER || directory.domains.has(envelopeDomain(to)),
	);
	const remote = envelope.to.filter((to) => !local.includes(to));
	const users = usersOf(directory, local, ctx.postmaster);

	const delivered = await deliverLocally(out, users);
	if (delivered !== undefined) return delivered;
	const queued = remote.length === 0 ? '' : await enqueue(out, remote);
	if (typeof queued !== 'string') return queued.refusal;

	const parts = [
		...(users.length > 0 ? [`delivered to ${users.join(', ')}`] : []),
		...(remote.length > 0
			? [`queued as ${queued} for ${remote.join(', ')}`]
			: []),
	];
	ctx.log(
		`${name}: ${from} ${parts.join('; ') || 'taken for nobody here any longer'}${out.signature === undefined ? ' (unsigned)' : ''}`,
	);
	return undefined;
}

/** The refusal of a From the user may not send as, logged. */
function checkFrom(
	ctx: SubmissionContext,
	name: string,
	from: string,
	user: string,
	header: Uint8Array,
): Reply | undefined {
	const yours = fromIsYours(ctx.directory, user, header);
	if (yours === 'yes') return undefined;
	ctx.log(`${name}: ${from} refused: ${FROM_PROBLEMS[yours]}`);
	if (yours === 'count') return FROM_COUNT;
	return yours === 'none' ? FROM_NO_ADDRESS : FROM_NOT_YOURS;
}

/** The header with what a sender could forge removed, as on the MX, and its DKIM signature. */
async function signed(
	base: Omit<Outgoing, 'kept' | 'signature'>,
	header: Uint8Array,
): Promise<Outgoing> {
	const { ctx, spooled } = base;
	const { kept } = stripForged(header, ctx.hostname, (id) =>
		ctx.directory.domains.has(id),
	);
	const authors = fromAddresses(header);
	const author = Array.isArray(authors) ? (authors[0] ?? '') : '';
	const signature = await ctx.sign(
		envelopeDomain(author),
		spooledStream(joinHeader([], kept), spooled.stream(spooled.bodyStart)),
	);
	return { ...base, kept, signature };
}

/** Adds the message to each local user's INBOX, `Return-Path` on top; `NOT_TAKEN` once the session ended. */
async function deliverLocally(
	out: Outgoing,
	users: readonly string[],
): Promise<Reply | undefined> {
	const { ctx, message, spooled, signature } = out;
	const top = signature === undefined ? [] : [signature];
	const prefix = joinHeader(
		[returnPath(message.envelope.from), ...top],
		out.kept,
	);
	for (const to of users) {
		if (message.signal.aborted) {
			ctx.log(
				`${out.name}: ${out.from} abandoned before ${to}: the session ended`,
			);
			return NOT_TAKEN;
		}
		await deliver(ctx, to, false, prefix, spooled);
	}
	return undefined;
}

/**
 * Queues the message for `remote`, the last step: its item's id, or the
 * reply to a refusal. Nothing is queued once the session ended, since the
 * client sends the message again.
 */
async function enqueue(
	out: Outgoing,
	remote: readonly string[],
): Promise<string | { readonly refusal: Reply }> {
	const { ctx, message, spooled, signature } = out;
	if (message.signal.aborted) {
		ctx.log(`${out.name}: ${out.from} not queued: the session ended`);
		return { refusal: NOT_TAKEN };
	}
	try {
		const item = await ctx.queue.enqueue(
			spooledStream(
				joinHeader(signature === undefined ? [] : [signature], out.kept),
				spooled.stream(spooled.bodyStart),
			),
			{ from: message.envelope.from, to: [...remote] },
		);
		return item.id;
	} catch (error) {
		ctx.log(`${out.name}: ${out.from} not queued: ${ctx.describe(error)}`);
		return {
			refusal:
				(error instanceof QueueError ? queueRefusal(error) : undefined) ??
				NOT_TAKEN,
		};
	}
}
