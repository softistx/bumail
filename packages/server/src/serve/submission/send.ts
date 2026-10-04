import { QueueError } from '@bumail/queue';
import type { ReceivedMessage, Reply, Session } from '@bumail/smtp';
import { joinHeader, returnPath, stripForged } from '../header';
import { deliver } from '../mx/deliver';
import { HEADER_TOO_LARGE, NOT_TAKEN, SPOOL_FULL } from '../mx/replies';
import { POSTMASTER, usersOf } from '../recipients';
import { type Spooled, spooledStream } from '../spool';
import type { SubmissionContext } from './index';
import {
	FROM_COUNT,
	FROM_NOT_YOURS,
	QUEUE_FULL,
	QUEUE_TOO_BIG,
	QUEUE_TOO_MANY,
} from './replies';
import { fromAddresses, fromIsYours } from './sender';

/** What a session keeps from MAIL FROM: the user, as the directory keeps it. */
export const USER = 'bumail.user';

/** The domain of an envelope recipient, lowercase; `''` for the bare `postmaster`. */
function domainOf(address: string): string {
	const at = address.lastIndexOf('@');
	return at === -1 ? '' : address.slice(at + 1).toLowerCase();
}

/** What a refusal of the queue's answers the client. */
function queueRefusal(error: QueueError): Reply | undefined {
	if (error.code === 'QUEUE_FULL') return QUEUE_FULL;
	if (error.code === 'MESSAGE_TOO_BIG') return QUEUE_TOO_BIG;
	if (error.code === 'TOO_MANY_RECIPIENTS') return QUEUE_TOO_MANY;
	return undefined;
}

/**
 * A submitted message, spooled, checked, signed, then handed on: to the
 * store for the hosted domains' recipients, to the queue for the others.
 * Nothing is kept unless every step went through.
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

async function handOn(
	ctx: SubmissionContext,
	name: string,
	message: ReceivedMessage,
	session: Session,
	spooled: Spooled,
): Promise<Reply | undefined> {
	const { log, directory } = ctx;
	const { envelope } = message;
	const user = String(session.data[USER]);
	const from = `${message.id} from ${user} <${envelope.from}>`;
	const header = spooled.header;
	if (header === undefined) {
		log(`${name}: ${from} refused: its header is over 256 KiB`);
		return HEADER_TOO_LARGE;
	}
	const yours = fromIsYours(directory, user, header);
	if (yours !== 'yes') {
		log(
			`${name}: ${from} refused: ${yours === 'count' ? 'it has no From field, or several' : 'its From field names another address'}`,
		);
		return yours === 'count' ? FROM_COUNT : FROM_NOT_YOURS;
	}

	// What a sender could forge to fool a reader here goes, as on the MX.
	const { kept } = stripForged(header, ctx.hostname, (id) =>
		directory.domains.has(id),
	);
	const authors = fromAddresses(header);
	const author = Array.isArray(authors) ? (authors[0] ?? '') : '';
	const signature = await ctx.sign(
		domainOf(author),
		spooledStream(joinHeader([], kept), spooled.stream(spooled.bodyStart)),
	);
	const top = signature === undefined ? [] : [signature];

	const local = envelope.to.filter(
		(to) => to === POSTMASTER || directory.domains.has(domainOf(to)),
	);
	const remote = envelope.to.filter((to) => !local.includes(to));
	const users = usersOf(directory, local, ctx.postmaster);

	// The client sends it again: nothing is kept once it was refused meanwhile.
	if (message.signal.aborted) return NOT_TAKEN;
	let queued = '';
	if (remote.length > 0) {
		try {
			const item = await ctx.queue.enqueue(
				spooledStream(joinHeader(top, kept), spooled.stream(spooled.bodyStart)),
				{ from: envelope.from, to: remote },
			);
			queued = item.id;
		} catch (error) {
			const refusal =
				error instanceof QueueError ? queueRefusal(error) : undefined;
			log(`${name}: ${from} not queued: ${ctx.describe(error)}`);
			return refusal ?? NOT_TAKEN;
		}
	}
	const prefix = joinHeader([returnPath(envelope.from), ...top], kept);
	for (const to of users) {
		if (message.signal.aborted) {
			log(`${name}: ${from} abandoned before ${to}: the session ended`);
			return NOT_TAKEN;
		}
		await deliver(ctx, to, false, prefix, spooled);
	}
	const parts = [
		...(users.length > 0 ? [`delivered to ${users.join(', ')}`] : []),
		...(remote.length > 0
			? [`queued as ${queued} for ${remote.join(', ')}`]
			: []),
	];
	log(
		`${name}: ${from} ${parts.join('; ') || 'taken for nobody here any longer'}${signature === undefined ? ' (unsigned)' : ''}`,
	);
	return undefined;
}
