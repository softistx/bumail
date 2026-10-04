import type { Resolver } from '@bumail/dns';
import type { ImapServer } from '@bumail/imap';
import type { Queue } from '@bumail/queue';
import type { SmtpServer } from '@bumail/smtp';
import type { MailStore } from '@bumail/store';
import type { ServerConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import type { Acme } from './acme';
import { createHealth } from './http/health';
import { createJmap } from './http/jmap';
import type { HttpListener } from './http/listener';
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
	| 'imap'
	| 'https'
	| 'http'
	| 'health';

export const LISTENERS: readonly ListenerName[] = [
	'mx',
	'submissions',
	'submission',
	'imaps',
	'imap',
	'https',
	'http',
	'health',
];

/** Whether `name` is started for `config`: its port is not 0, and `http` only serves `tls.mode = "acme"`. */
export function enabled(name: ListenerName, config: ServerConfig): boolean {
	return (
		config.ports[name] !== 0 && (name !== 'http' || config.acme !== undefined)
	);
}

/** What each listener's log line adds after its address. */
export const DESCRIPTION: Record<ListenerName, string> = {
	mx: 'SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only',
	submissions:
		'submission over TLS from the first byte: AUTH required, then mail to anywhere',
	submission:
		'submission with STARTTLS: AUTH only after TLS, then mail to anywhere',
	imaps: 'IMAP over TLS from the first byte',
	imap: 'IMAP with STARTTLS, required before any login',
	https: 'JMAP over HTTPS: Basic auth for the users of the directory',
	http: 'ACME HTTP-01 challenges on /.well-known/acme-challenge/, a redirect to HTTPS for GET /, 404 for the rest',
	health:
		'health check, GET /healthz: 200 when every listener is up and the directory and the store answer, else 503',
};

/** What a listener's log line adds after its address: `DESCRIPTION`, JMAP's by its mode. */
export function descriptionOf(
	name: ListenerName,
	config: ServerConfig,
): string {
	if (name !== 'https' || config.jmap.mode !== 'proxy')
		return DESCRIPTION[name];
	const { length } = config.jmap.trusted;
	const who =
		length === 1
			? '1 trusted proxy, which ends TLS'
			: `${length} trusted proxies, which end TLS`;
	return `JMAP over plain HTTP for ${who}: Basic auth for the users of the directory`;
}

/** The address a listener binds to: JMAP's, ACME's and the health check's own, else `bind`. */
export function bindOf(name: ListenerName, config: ServerConfig): string {
	if (name === 'https') return config.jmap.bind;
	if (name === 'http') return config.acme?.bind ?? config.bind;
	return name === 'health' ? config.health.bind : config.bind;
}

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
	  }
	| {
			readonly name: ListenerName;
			readonly kind: 'http';
			readonly server: HttpListener;
	  };

/** What the listeners share: the server's resources, opened. */
export interface Resources {
	readonly config: ServerConfig;
	readonly directory: Directory;
	readonly store: MailStore;
	readonly resolver: Resolver;
	/** The pair TLS listeners are created with; under `tls.mode = "acme"`, set once the first certificate is there. */
	tls: TlsFiles;
	/** With `tls.mode = "acme"`. */
	readonly acme?: Acme | undefined;
	readonly spool: Spool;
	readonly log: Log;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
	/** Deliveries under way, which a stop waits for. */
	readonly inflight: Set<Promise<unknown>>;
	/** The names of the listeners bound and not stopping, for the health check. */
	readonly up: Set<ListenerName>;
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
	if (name === 'https') {
		const server = createJmap({ config, directory, store, tls, log, describe });
		return { name, kind: 'http', server };
	}
	if (name === 'http') {
		if (resources.acme === undefined) throw new Error('http needs ACME');
		return { name, kind: 'http', server: resources.acme.challenge.listener };
	}
	if (name === 'health') {
		const expected = LISTENERS.filter(
			(other) => other !== 'health' && enabled(other, config),
		);
		const { acme } = resources;
		const server = createHealth({
			config,
			directory,
			store,
			expected,
			up: resources.up,
			...(acme === undefined ? {} : { tls: () => acme.tls }),
			log,
		});
		return { name, kind: 'http', server };
	}
	if (name === 'submissions' || name === 'submission') {
		const submission = {
			hostname: config.hostname,
			directory,
			store,
			submission: config.submission,
			postmaster: config.postmaster,
			tls,
			proxyProtocol: config.proxyProtocol,
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
			proxyProtocol: config.proxyProtocol,
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
		proxyProtocol: config.proxyProtocol,
		spool: resources.spool,
		log,
		describe,
		...resources.delivery,
	});
	return { name, kind: 'smtp', server };
}
