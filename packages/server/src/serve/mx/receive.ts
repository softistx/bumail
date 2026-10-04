import type { SpfResult } from '@bumail/auth';
import type { ReceivedMessage, Reply, Session } from '@bumail/smtp';
import { joinHeader, returnPath, stripForged } from '../header';
import { judge, type Verdict } from '../inbound';
import type { Spooled } from '../spool';
import { deliver, usersOf } from './deliver';
import type { MxContext } from './index';
import {
	DMARC_DEFERRED,
	dmarcRejected,
	FROM_UNREADABLE,
	HEADER_TOO_LARGE,
	NO_RECIPIENT,
	NOT_TAKEN,
	SPOOL_FULL,
} from './replies';

/** What a session keeps between MAIL FROM and the end of DATA: its SPF check. */
export const SPF = 'bumail.spf';

/** `spf=… dkim=… dmarc=…`, for the log. */
function summary(verdict: Verdict): string {
	const dkim = verdict.dkim.map((d) => d.result).join(',') || 'none';
	return `spf=${verdict.spf?.result ?? 'none'} dkim=${dkim} dmarc=${verdict.dmarc.result}`;
}

export async function receive(
	ctx: MxContext,
	message: ReceivedMessage,
	session: Session,
): Promise<Reply | undefined> {
	let spooled: Spooled;
	try {
		const written = await ctx.spool.write(message.id, message.content);
		if (written === 'full') {
			ctx.log(
				`mx: ${message.id} from ${session.remoteAddress} deferred: the spool is full`,
			);
			return SPOOL_FULL;
		}
		spooled = written;
	} catch (error) {
		// The stream's own refusal (too big, a bare line break, a lost
		// connection) replaces this reply, and says why; anything else is
		// the server's, such as a full disk.
		if (!message.signal.aborted) {
			ctx.log(
				`mx: ${message.id} from ${session.remoteAddress} not spooled: ${ctx.describe(error)}`,
			);
		}
		return NOT_TAKEN;
	}
	try {
		return await check(ctx, message, session, spooled);
	} finally {
		await spooled.remove();
	}
}

async function check(
	ctx: MxContext,
	message: ReceivedMessage,
	session: Session,
	spooled: Spooled,
): Promise<Reply | undefined> {
	const { log } = ctx;
	const { envelope } = message;
	const from = `${message.id} from ${session.remoteAddress} <${envelope.from}>`;
	const header = spooled.header;
	if (header === undefined) {
		log(`mx: ${from} refused: its header is over 256 KiB`);
		return HEADER_TOO_LARGE;
	}
	const users = usersOf(ctx.directory, envelope.to);
	if (users.length === 0) {
		log(`mx: ${from} refused: no recipient is here any longer`);
		return NO_RECIPIENT;
	}
	const spf = (await session.data[SPF]) as SpfResult | undefined;
	const verdict = await judge({ header, whole: () => spooled.stream() }, spf, {
		hostname: ctx.hostname,
		resolver: ctx.resolver,
		mode: ctx.inbound.dmarc,
		// A bounce's SPF is its HELO name's.
		spfIdentity: envelope.from === '' ? 'helo' : 'mailfrom',
	});
	if (verdict.action === 'reject') {
		log(`mx: ${from} refused by DMARC (${summary(verdict)})`);
		return verdict.dmarc.result === 'permerror'
			? FROM_UNREADABLE
			: dmarcRejected(verdict.dmarc.domain);
	}
	if (verdict.action === 'defer') {
		log(
			`mx: ${from} deferred: DMARC or DKIM did not finish (${summary(verdict)})`,
		);
		return DMARC_DEFERRED;
	}
	const { kept } = stripForged(header, ctx.hostname, (id) =>
		ctx.directory.domains.has(id),
	);
	const prefix = joinHeader([returnPath(envelope.from), verdict.field], kept);
	const junk = verdict.action === 'junk';
	for (const user of users) {
		// The client will send it again: nothing more is kept once the
		// message was refused meanwhile (a timeout, a lost connection, a stop).
		if (message.signal.aborted) {
			log(`mx: ${from} abandoned before ${user}: the session ended`);
			return NOT_TAKEN;
		}
		await deliver(ctx, user, junk, prefix, spooled);
	}
	log(
		`mx: ${from} delivered to ${users.join(', ')}${junk ? ' (Junk)' : ''} (${summary(verdict)})`,
	);
	return undefined;
}
