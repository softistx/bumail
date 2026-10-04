import type { Queue } from '@bumail/queue';
import {
	createSmtpServer,
	type SmtpServer,
	type TlsOptions,
} from '@bumail/smtp';
import { isMailbox } from '@bumail/smtp/client';
import type { MailStore } from '@bumail/store';
import type { SubmissionConfig } from '../../config/types';
import { smtpAuthenticate } from '../../directory/adapters';
import type { Directory } from '../../directory/directory';
import type { Log } from '../log';
import { POSTMASTER_UNKNOWN, SPOOL_FULL, USER_UNKNOWN } from '../mx/replies';
import { usersFor } from '../recipients';
import type { Spool } from '../spool';
import { ADDRESS_UNSENDABLE, senderNotYours } from './replies';
import { send, USER } from './send';
import { sendsAs, userOf } from './sender';

/** A DKIM signer: the `DKIM-Signature` field for a message `From` a domain, or `undefined` with no key for it. */
export type Signer = (
	domain: string,
	message: ReadableStream<Uint8Array>,
) => Promise<string | undefined>;

/** What a submission listener needs from the server. */
export interface SubmissionContext {
	readonly hostname: string;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly submission: SubmissionConfig;
	/** `postmaster` from the configuration. */
	readonly postmaster: string | undefined;
	readonly tls: TlsOptions;
	/** Where messages wait while they are signed and handed on, within its byte budget. */
	readonly spool: Spool;
	/** Where mail for other domains goes. */
	readonly queue: Queue;
	readonly sign: Signer;
	readonly log: Log;
	/** Told of each account a message was added to: IMAP's IDLE looks at once. */
	onDelivered(accountId: string): void;
	/** Keeps a delivery under way, so a stop waits for it before closing the store. */
	track<T>(work: Promise<T>): Promise<T>;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
}

/**
 * Submission from the server's own users: `submissions` with TLS from
 * the first byte (465), `submission` with STARTTLS (587). `@bumail/smtp`
 * in `submission` mode offers AUTH only over TLS and refuses MAIL until
 * the session authenticated, against the directory. A user sends as
 * itself or one of its aliases only, in MAIL FROM and in From. Mail for
 * a hosted domain goes straight to the store; any other, to the queue.
 */
export function createSubmission(
	ctx: SubmissionContext,
	name: 'submissions' | 'submission',
): SmtpServer {
	const { directory, log, submission } = ctx;
	return createSmtpServer({
		hostname: ctx.hostname,
		mode: 'submission',
		implicitTls: name === 'submissions',
		localDomains: (domain) => directory.domains.has(domain),
		tls: ctx.tls,
		maxMessageSize: submission.maxMessageSize,
		maxRecipients: submission.maxRecipients,
		maxConnections: submission.maxConnections,
		maxConnectionsPerClient: submission.maxConnectionsPerClient,
		handshakeTimeout: submission.handshakeTimeout,
		authenticate: smtpAuthenticate(directory, {
			onRefused: (reason, ip) =>
				log(`${name}: login refused from ${ip}: ${reason}`),
		}),
		onMailFrom(path, session) {
			const user = userOf(directory, session.user);
			if (user === undefined || !sendsAs(directory, user, path.address)) {
				log(
					`${name}: ${user ?? session.user ?? 'nobody'} from ${session.remoteAddress} refused as sender <${path.address}>`,
				);
				return senderNotYours(path.address);
			}
			if (!ctx.spool.hasRoom(submission.maxMessageSize)) {
				log(
					`${name}: MAIL FROM from ${session.remoteAddress} deferred: the spool is full`,
				);
				return SPOOL_FULL;
			}
			session.data[USER] = user;
			return undefined;
		},
		onRcptTo(path) {
			if (path.postmaster) {
				return usersFor(directory, path.address, ctx.postmaster) === undefined
					? POSTMASTER_UNKNOWN
					: undefined;
			}
			if (directory.domains.has(path.domain)) {
				return directory.resolve(path.address) === undefined
					? USER_UNKNOWN
					: undefined;
			}
			return isMailbox(path.address) ? undefined : ADDRESS_UNSENDABLE;
		},
		onData(message, session) {
			return ctx.track(send(ctx, name, message, session));
		},
		onError(error, session) {
			log(
				`${name}: error in a session from ${session.remoteAddress}: ${ctx.describe(error)}`,
			);
		},
	});
}
