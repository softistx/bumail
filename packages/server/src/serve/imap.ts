import { createImapServer, type ImapServer } from '@bumail/imap';
import type { MailStore } from '@bumail/store';
import type { ProxyProtocolConfig } from '../config/types';
import { imapAuthenticate } from '../directory/adapters';
import type { Directory } from '../directory/directory';
import type { Log } from './log';
import { proxyOption } from './proxy';
import type { TlsFiles } from './tls';

/** What an IMAP listener needs from the server. */
export interface ImapContext {
	readonly hostname: string;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly tls: TlsFiles;
	/** The proxies whose PROXY header is read; `undefined`: off. */
	readonly proxyProtocol?: ProxyProtocolConfig | undefined;
	readonly log: Log;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
}

/**
 * IMAP serving the store: `imaps` with TLS from the first byte (993),
 * `imap` with STARTTLS (143), where `@bumail/imap` refuses LOGIN and
 * AUTHENTICATE until TLS is on. Logins go through the directory, counted
 * per client by its limiter, the client's address taken from the socket.
 */
export function createImap(
	ctx: ImapContext,
	name: 'imaps' | 'imap',
): ImapServer {
	const { log } = ctx;
	return createImapServer({
		hostname: ctx.hostname,
		store: ctx.store,
		tls: ctx.tls,
		...proxyOption(ctx.proxyProtocol),
		implicitTls: name === 'imaps',
		authenticate: imapAuthenticate(ctx.directory, ctx.store, {
			onRefused: (reason, ip) =>
				log(`${name}: login refused from ${ip}: ${reason}`),
		}),
		onError(error, session) {
			log(
				`${name}: error in a session from ${session.remoteAddress}: ${ctx.describe(error)}`,
			);
		},
	});
}
