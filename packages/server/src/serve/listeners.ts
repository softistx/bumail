import type { Resolver } from '@bumail/dns';
import type { ImapServer } from '@bumail/imap';
import type { Queue } from '@bumail/queue';
import type { SmtpServer } from '@bumail/smtp';
import type { MailStore } from '@bumail/store';
import type { PortsConfig, ServerConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import { createImap } from './imap';
import type { Log } from './log';
import { createMx } from './mx';
import type { Spool } from './spool';
import { createSubmission, type Signer } from './submission';
import type { TlsFiles } from './tls';

/** The listeners `serve` starts, in the order it starts them. */
export type ListenerName =
	| 'mx'
	| 'submissions'
	| 'submission'
	| 'imaps'
	| 'imap';

export const LISTENERS: readonly ListenerName[] = [
	'mx',
	'submissions',
	'submission',
	'imaps',
	'imap',
];

/** The ports whose listeners arrive in a later slice: logged, never bound. */
export const LATER: readonly (keyof PortsConfig)[] = [
	'https',
	'http',
	'health',
];

/** What each listener's log line adds after its address. */
export const DESCRIPTION: Record<ListenerName, string> = {
	mx: 'SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only',
	submissions:
		'submission over TLS from the first byte: AUTH required, then mail to anywhere',
	submission:
		'submission with STARTTLS: AUTH only after TLS, then mail to anywhere',
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
	/** Where mail for other domains goes. */
	readonly queue: Queue;
	readonly sign: Signer;
	/** Built once (`delivery` in `resources.ts`), for the MX, submission and the queue. */
	readonly delivery: Delivery;
}

/** What each delivery is told to: the IMAP servers notified, the work kept for a stop. */
export interface Delivery {
	/** Told of each account a message was added to: IMAP's IDLE looks at once. */
	onDelivered(accountId: string): void;
	/** Keeps a delivery under way, so a stop waits for it before closing the store. */
	track<T>(work: Promise<T>): Promise<T>;
}

/** Creates the listener `name` on `resources`, not yet bound. */
export function createListener(
	name: ListenerName,
	resources: Resources,
): Listener {
	const { config, directory, store, tls, log, describe } = resources;
	if (name === 'submissions' || name === 'submission') {
		const submission = {
			hostname: config.hostname,
			directory,
			store,
			submission: config.submission,
			postmaster: config.postmaster,
			tls,
			spool: resources.spool,
			queue: resources.queue,
			sign: resources.sign,
			log,
			describe,
			...resources.delivery,
		};
		return { name, kind: 'smtp', server: createSubmission(submission, name) };
	}
	if (name !== 'mx') {
		const imap = {
			hostname: config.hostname,
			directory,
			store,
			tls,
			log,
			describe,
		};
		return {
			name,
			kind: 'imap',
			server: createImap(imap, name),
		};
	}
	const server = createMx({
		hostname: config.hostname,
		directory,
		store,
		resolver: resources.resolver,
		inbound: config.inbound,
		postmaster: config.postmaster,
		tls,
		spool: resources.spool,
		log,
		describe,
		...resources.delivery,
	});
	return { name, kind: 'smtp', server };
}
