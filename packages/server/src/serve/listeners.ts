import type { Resolver } from '@bumail/dns';
import type { ImapServer } from '@bumail/imap';
import type { SmtpServer } from '@bumail/smtp';
import type { MailStore } from '@bumail/store';
import type { PortsConfig, ServerConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import { createImap } from './imap';
import type { Log } from './log';
import { createMx } from './mx';
import type { Spool } from './spool';
import type { TlsFiles } from './tls';

/** The listeners `serve` starts, in the order it starts them. */
export type ListenerName = 'mx' | 'imaps' | 'imap';

export const LISTENERS: readonly ListenerName[] = ['mx', 'imaps', 'imap'];

/** The ports whose listeners arrive in a later slice: logged, never bound. */
export const LATER: readonly (keyof PortsConfig)[] = [
	'submissions',
	'submission',
	'https',
	'http',
	'health',
];

/** What each listener's log line adds after its address. */
export const DESCRIPTION: Record<ListenerName, string> = {
	mx: 'SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only',
	imaps: 'IMAP over TLS from the first byte',
	imap: 'IMAP with STARTTLS, required before any login',
};

/** A listener created, SMTP or IMAP. */
export type Listener =
	| {
			readonly name: ListenerName;
			readonly kind: 'smtp';
			readonly server: SmtpServer;
	  }
	| {
			readonly name: ListenerName;
			readonly kind: 'imap';
			readonly server: ImapServer;
	  };

/** What the listeners share: the server's resources, opened. */
export interface Resources {
	readonly config: ServerConfig;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly resolver: Resolver;
	readonly tls: TlsFiles;
	readonly spool: Spool;
	readonly log: Log;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
	/** Deliveries under way, which a stop waits for. */
	readonly inflight: Set<Promise<unknown>>;
	/** The IMAP servers started, told of each delivery. */
	readonly imaps: ImapServer[];
}

/** Creates the listener `name` on `resources`, not yet bound. */
export function createListener(
	name: ListenerName,
	resources: Resources,
): Listener {
	const { config, directory, store, tls, log, describe } = resources;
	if (name !== 'mx') {
		const imap = {
			hostname: config.hostname,
			directory,
			store,
			tls,
			log,
			describe,
		};
		return { name, kind: 'imap', server: createImap(imap, name) };
	}
	const server = createMx({
		hostname: config.hostname,
		directory,
		store,
		resolver: resources.resolver,
		inbound: config.inbound,
		tls,
		spool: resources.spool,
		log,
		describe,
		onDelivered: (accountId) => {
			for (const imap of resources.imaps) imap.notify(accountId);
		},
		track: (work) => {
			resources.inflight.add(work);
			void work.finally(() => resources.inflight.delete(work)).catch(() => {});
			return work;
		},
	});
	return { name, kind: 'smtp', server };
}
