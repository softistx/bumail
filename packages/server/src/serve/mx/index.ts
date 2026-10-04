import type { Resolver } from '@bumail/dns';
import {
	createSmtpServer,
	type SmtpServer,
	type TlsOptions,
} from '@bumail/smtp';
import type { MailStore } from '@bumail/store';
import type { InboundConfig } from '../../config/types';
import type { Directory } from '../../directory/directory';
import { startSpf } from '../inbound';
import type { Log } from '../log';
import { usersFor } from '../recipients';
import type { Spool } from '../spool';
import { receive, SPF } from './receive';
import { POSTMASTER_UNKNOWN, SPOOL_FULL, USER_UNKNOWN } from './replies';

export * from './replies';

/** What the MX listener needs from the server. */
export interface MxContext {
	readonly hostname: string;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly resolver: Resolver;
	readonly inbound: InboundConfig;
	/** `postmaster` from the configuration. */
	readonly postmaster: string | undefined;
	readonly tls: TlsOptions;
	/** Where messages wait while they are checked, within its byte budget. */
	readonly spool: Spool;
	readonly log: Log;
	/** Told of each account a message was added to: IMAP's IDLE looks at once. */
	onDelivered(accountId: string): void;
	/** Keeps a delivery under way, so a stop waits for it before closing the store. */
	track<T>(work: Promise<T>): Promise<T>;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
}

/**
 * SMTP from other servers: mail for the domains and addresses the
 * directory holds, from anyone, relayed nowhere. No `authenticate` is
 * given, so AUTH is never offered and every session is unauthenticated:
 * `@bumail/smtp` refuses a recipient in a domain not hosted with
 * `554 5.7.1 Relay access denied`, and `onRcptTo` refuses an address the
 * directory does not resolve with `550 5.1.1`. The bare `<postmaster>`
 * goes to `postmaster`, else `postmaster@` the first hosted domain, and
 * is refused with `550 5.1.1` when that does not resolve. STARTTLS is
 * offered, not required; one client holds `maxConnectionsPerClient`
 * sessions at most.
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
		maxConnectionsPerClient: ctx.inbound.maxConnectionsPerClient,
		onMailFrom(path, session) {
			// A message as large as allowed must fit, besides those waiting.
			if (!ctx.spool.hasRoom(ctx.inbound.maxMessageSize)) {
				log(
					`mx: MAIL FROM from ${session.remoteAddress} deferred: the spool is full`,
				);
				return SPOOL_FULL;
			}
			session.data[SPF] = startSpf(
				{
					ip: session.remoteAddress,
					mailFrom: path.address,
					helo: session.helo ?? '',
				},
				ctx.resolver,
			);
			return undefined;
		},
		onRcptTo(path) {
			if (path.postmaster) {
				return usersFor(directory, path.address, ctx.postmaster) === undefined
					? POSTMASTER_UNKNOWN
					: undefined;
			}
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
