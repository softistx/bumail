import type { Queue } from '@bumail/queue';
import {
	createSmtpServer,
	type Path,
	type Reply,
	type SmtpServer,
	type TlsOptions,
} from '@bumail/smtp';
import { isMailbox } from '@bumail/smtp/client';
import type { MailStore } from '@bumail/store';
import type { SubmissionConfig } from '../../config/types';
import { checkLogin } from '../../directory/adapters';
import type { AuthFailure } from '../../directory/authenticate';
import type { Directory } from '../../directory/directory';
import type { Log } from '../log';
import { POSTMASTER_UNKNOWN, SPOOL_FULL, USER_UNKNOWN } from '../mx/replies';
import { usersFor } from '../recipients';
import type { Spool } from '../spool';
import { ADDRESS_LITERAL, ADDRESS_UNSENDABLE, senderNotYours } from './replies';
import { send, USER } from './send';
import { LOGIN_VERSION, sendsAs, userOf } from './sender';

/**
 * A DKIM signer: the `DKIM-Signature` field for a message `From` a
 * domain (as `envelopeDomain` gives it, `''` for none), or `undefined`
 * with no key for it.
 */
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
	const refusals = {
		onRefused: (reason: AuthFailure, ip: string) =>
			log(`${name}: login refused from ${ip}: ${reason}`),
	};
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
		async authenticate({ username, password }, session) {
			const login = await checkLogin(
				directory,
				username,
				password,
				session.remoteAddress,
				refusals,
			);
			// The version the password was checked against, not one read
			// after: a new password committed during the verify must end
			// this session too. MAIL FROM checks it still holds (`userOf`).
			if (login !== undefined) session.data[LOGIN_VERSION] = login.version;
			return login !== undefined;
		},
		onMailFrom(path, session) {
			const user = userOf(directory, session.user, session.data[LOGIN_VERSION]);
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
		onRcptTo: (path) => checkRecipient(ctx, path),
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

/**
 * RCPT TO on submission: the bare `<postmaster>` and a hosted domain's
 * address must resolve here; an address literal is refused; any other
 * must be one the queue can send
 * to (`isMailbox`, which `sendMail` checks again), so the queue never
 * takes an address it would only bounce. `@bumail/smtp` parses paths as
 * `isMailbox` does today; the check keeps the two from drifting apart.
 */
export function checkRecipient(
	ctx: Pick<SubmissionContext, 'directory' | 'postmaster'>,
	path: Path,
): Reply | undefined {
	const { directory } = ctx;
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
	// An address literal names a host, not a domain: `carol@[127.0.0.1]`
	// would have the queue connect wherever a user points it, this host's
	// own services included.
	if (path.domain.startsWith('[')) return ADDRESS_LITERAL;
	return isMailbox(path.address) ? undefined : ADDRESS_UNSENDABLE;
}
