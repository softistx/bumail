import type { SpfResult } from '@bumail/auth';
import type { Resolver } from '@bumail/dns';
import {
	createSmtpServer,
	type ReceivedMessage,
	type Reply,
	reply,
	type Session,
	type SmtpServer,
	type TlsOptions,
} from '@bumail/smtp';
import type { MailStore } from '@bumail/store';
import type { InboundConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import { provisionAccount } from '../store/accounts';
import { joinHeader, returnPath, stripForged } from './header';
import { judge, startSpf, type Verdict } from './inbound';
import type { Log } from './log';
import { type Spooled, spool, spooledStream } from './spool';

/** What the MX listener needs from the server. */
export interface MxContext {
	readonly hostname: string;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly resolver: Resolver;
	readonly inbound: InboundConfig;
	readonly tls: TlsOptions;
	/** Where messages wait while they are checked. */
	readonly spoolDir: string;
	readonly log: Log;
	/** Told of each account a message was added to: IMAP's IDLE looks at once. */
	onDelivered(accountId: string): void;
	/** Keeps a delivery under way, so a stop waits for it before closing the store. */
	track<T>(work: Promise<T>): Promise<T>;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
}

/** What a session keeps between MAIL FROM and the end of DATA. */
const SPF = 'bumail.spf';

export const USER_UNKNOWN = reply(550, '5.1.1', 'User unknown');
export const HEADER_TOO_LARGE = reply(552, '5.3.4', 'Message header too large');
export const NO_RECIPIENT = reply(
	550,
	'5.1.1',
	'No recipient of this message is here any longer',
);
export const DMARC_DEFERRED = reply(
	451,
	'4.7.0',
	'DMARC check failed, try again later',
);
const NOT_TAKEN = reply(451, '4.3.0', 'Message not taken, try again later');

export const FROM_UNREADABLE = reply(
	550,
	'5.7.1',
	'The From field cannot be evaluated for DMARC: none, several, or not one mailbox',
);

export function dmarcRejected(domain: string): Reply {
	return reply(
		550,
		'5.7.1',
		`Rejected by the DMARC policy of ${domain || 'the sender domain'}`,
	);
}

/** The users a message for `to` goes to, each once: aliases expanded. */
function usersOf(directory: Directory, to: readonly string[]): string[] {
	const users = new Set<string>();
	for (const address of to) {
		for (const user of directory.resolve(address) ?? []) users.add(user);
	}
	return [...users];
}

/** `spf=… dkim=… dmarc=…`, for the log. */
function summary(verdict: Verdict): string {
	const dkim = verdict.dkim.map((d) => d.result).join(',') || 'none';
	return `spf=${verdict.spf?.result ?? 'none'} dkim=${dkim} dmarc=${verdict.dmarc.result}`;
}

/**
 * SMTP from other servers: mail for the domains and addresses the
 * directory holds, from anyone, relayed nowhere. No `authenticate` is
 * given, so AUTH is never offered and every session is unauthenticated:
 * `@bumail/smtp` refuses a recipient in a domain not hosted with
 * `554 5.7.1 Relay access denied`, and `onRcptTo` refuses an address the
 * directory does not resolve with `550 5.1.1`. STARTTLS is offered, not
 * required.
 */
export function createMx(ctx: MxContext): SmtpServer {
	const { directory, log } = ctx;
	return createSmtpServer({
		hostname: ctx.hostname,
		mode: 'mx',
		localDomains: (domain) => directory.domains.has(domain),
		tls: ctx.tls,
		maxMessageSize: ctx.inbound.maxMessageSize,
		maxConnections: ctx.inbound.maxConnections,
		onMailFrom(path, session) {
			session.data[SPF] = startSpf(
				{
					ip: session.remoteAddress,
					mailFrom: path.address,
					helo: session.helo ?? '',
				},
				ctx.resolver,
			);
		},
		onRcptTo(path) {
			return directory.resolve(path.address) === undefined
				? USER_UNKNOWN
				: undefined;
		},
		onData(message, session) {
			return ctx.track(receive(ctx, message, session));
		},
		onError(error, session) {
			log(
				`mx: error in a session from ${session.remoteAddress}: ${ctx.describe(error)}`,
			);
		},
	});
}

async function receive(
	ctx: MxContext,
	message: ReceivedMessage,
	session: Session,
): Promise<Reply | undefined> {
	let spooled: Spooled;
	try {
		spooled = await spool(ctx.spoolDir, message.id, message.content);
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
	const verdict = await judge(
		{ header, whole: () => Bun.file(spooled.file).stream() },
		spf,
		{ hostname: ctx.hostname, resolver: ctx.resolver, mode: ctx.inbound.dmarc },
	);
	if (verdict.action === 'reject') {
		log(`mx: ${from} refused by DMARC (${summary(verdict)})`);
		return verdict.dmarc.result === 'permerror'
			? FROM_UNREADABLE
			: dmarcRejected(verdict.dmarc.domain);
	}
	if (verdict.action === 'defer') {
		log(`mx: ${from} deferred: DMARC temperror (${summary(verdict)})`);
		return DMARC_DEFERRED;
	}
	const { kept } = stripForged(header, ctx.hostname);
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

/** Adds the message to `user`'s INBOX, or Junk, its account and mailboxes created if need be. */
async function deliver(
	ctx: MxContext,
	user: string,
	junk: boolean,
	prefix: Uint8Array,
	spooled: Spooled,
): Promise<void> {
	const { store } = ctx;
	const account = await provisionAccount(store, user);
	const mailbox =
		(junk ? await store.findMailbox(account.id, 'junk') : undefined) ??
		(await store.findMailbox(account.id, 'inbox'));
	if (mailbox === undefined) {
		throw new Error(`the account of ${user} has no INBOX`);
	}
	await store.addMessage(account.id, mailbox.id, {
		content: spooledStream(prefix, spooled.file, spooled.bodyStart),
	});
	ctx.onDelivered(account.id);
}
