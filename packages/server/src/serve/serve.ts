import { cachedResolver, nodeResolver, type Resolver } from '@bumail/dns';
import type { ImapServer } from '@bumail/imap';
import type { SmtpServer } from '@bumail/smtp';
import type { PortsConfig, ServerConfig } from '../config/types';
import { directoryFile } from '../directory/database';
import { Directory } from '../directory/directory';
import { ServerError } from '../errors';
import { maskedFor, type OpenedStore, openStore } from '../store/open';
import { createImap } from './imap';
import type { Log } from './log';
import { createMx } from './mx';
import { openSpool } from './spool';
import { readTls } from './tls';

/** The listeners `serve` starts. */
export type ListenerName = 'mx' | 'imaps' | 'imap';

/** The ports whose listeners arrive in a later slice: logged, never bound. */
export const LATER: readonly (keyof PortsConfig)[] = [
	'submissions',
	'submission',
	'https',
	'http',
	'health',
];

/** Milliseconds one DNS try has, and tries per query, for the inbound checks. */
export const DNS_TIMEOUT_MS = 5000;
export const DNS_TRIES = 2;

/** Seconds a stop waits for SMTP sessions to end, by default. */
export const DEFAULT_DRAIN_SECONDS = 10;

/** Seconds a stop then waits for deliveries already writing to the store. */
const SETTLE_MS = 5000;

export interface ServeOptions {
	/** Where the log goes, a line at a time. Default standard output. */
	readonly log?: Log;
	/** The DNS for SPF, DKIM and DMARC. Default the system's, cached, each try bounded to 5 s, 2 tries. */
	readonly resolver?: Resolver;
	/**
	 * The port to bind `listener` to, given the one configured (never 0:
	 * a listener configured off is not started). Default the configured
	 * one; a spec answers 0, for a free port.
	 */
	port?(listener: ListenerName, configured: number): number;
	/** Seconds `stop` waits for SMTP sessions to end before hanging up on them. Default 10. */
	readonly drainSeconds?: number;
}

/** A listener bound. */
export interface Listening {
	readonly name: ListenerName;
	readonly hostname: string;
	readonly port: number;
}

/** The server, running. */
export interface RunningServer {
	readonly listening: readonly Listening[];
	/**
	 * Stops: no new connection; IMAP sessions closed; SMTP sessions given
	 * `drainSeconds` to end, then closed; deliveries under way given 5 s
	 * to finish; the store and the directory closed. `force` skips the
	 * waits — a second signal. Resolves once all is closed; a second call
	 * answers the same promise.
	 */
	stop(options?: { readonly force?: boolean }): Promise<void>;
}

const defaultLog: Log = (line) => {
	process.stdout.write(`${line}\n`);
};

interface Started {
	readonly name: ListenerName;
	readonly server: SmtpServer | ImapServer;
	readonly kind: 'smtp' | 'imap';
}

/** What each listener's log line adds after its address. */
const DESCRIPTION: Record<ListenerName, string> = {
	mx: 'SMTP from other servers: STARTTLS offered, no AUTH, mail for hosted addresses only',
	imaps: 'IMAP over TLS from the first byte',
	imap: 'IMAP with STARTTLS, required before any login',
};

/**
 * Runs the server for `config`: reads the certificate (`tls.mode =
 * "files"`; `"acme"` is `NOT_IMPLEMENTED`), opens the directory and the
 * mail store, and starts each listener of this slice whose port is not 0
 * — `mx`, `imaps`, `imap` — logging one line each. The other ports are
 * logged as arriving later, and bound to nothing. What cannot be opened
 * or bound is `ServerError('UNAVAILABLE')`, with whatever was started
 * stopped again.
 */
export async function serve(
	config: ServerConfig,
	options: ServeOptions = {},
): Promise<RunningServer> {
	const log = options.log ?? defaultLog;
	const tls = readTls(config.tls);
	const spoolDir = openSpool(config.data);
	const directory = Directory.open({
		file: directoryFile(config.directory.url),
	});
	let opened: OpenedStore;
	try {
		opened = openStore(config.store);
	} catch (error) {
		directory.close();
		throw error;
	}
	const { store } = opened;
	const describe = (error: unknown) =>
		maskedFor(
			error instanceof Error ? error.message : String(error),
			config.store.url,
		);
	const resolver =
		options.resolver ??
		cachedResolver(nodeResolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }));
	const inflight = new Set<Promise<unknown>>();
	const started: Started[] = [];
	const imaps: ImapServer[] = [];

	const closeAll = async () => {
		for (const { server } of started) server.stop(true);
		await opened.close();
		directory.close();
	};

	const listeners: [
		ListenerName,
		() => SmtpServer | ImapServer,
		'smtp' | 'imap',
	][] = [
		[
			'mx',
			() =>
				createMx({
					hostname: config.hostname,
					directory,
					store,
					resolver,
					inbound: config.inbound,
					tls,
					spoolDir,
					log,
					describe,
					onDelivered: (accountId) => {
						for (const imap of imaps) imap.notify(accountId);
					},
					track: (work) => {
						inflight.add(work);
						void work.finally(() => inflight.delete(work)).catch(() => {});
						return work;
					},
				}),
			'smtp',
		],
		[
			'imaps',
			() =>
				createImap(
					{ hostname: config.hostname, directory, store, tls, log, describe },
					'imaps',
				),
			'imap',
		],
		[
			'imap',
			() =>
				createImap(
					{ hostname: config.hostname, directory, store, tls, log, describe },
					'imap',
				),
			'imap',
		],
	];

	const listening: Listening[] = [];
	for (const [name, create, kind] of listeners) {
		const configured = config.ports[name];
		if (configured === 0) continue;
		const port = options.port?.(name, configured) ?? configured;
		const server = create();
		try {
			const bound = await server.listen({ port, hostname: config.bind });
			listening.push({ name, ...bound });
		} catch (error) {
			await closeAll();
			const message = error instanceof Error ? error.message : String(error);
			const code = (error as { code?: unknown } | undefined)?.code;
			const reason =
				typeof code === 'string' && !message.includes(code)
					? `${message}: ${code}`
					: message;
			throw new ServerError(
				'UNAVAILABLE',
				`${name} cannot listen on ${config.bind}:${port} (${reason})`,
			);
		}
		started.push({ name, server, kind });
		if (kind === 'imap') imaps.push(server as ImapServer);
	}

	log(`bumail: serving ${config.hostname}`);
	for (const { name, hostname, port } of listening) {
		log(
			`bumail: ${name} listening on ${hostname}:${port}: ${DESCRIPTION[name]}`,
		);
	}
	for (const name of LATER) {
		const port = config.ports[name];
		if (port !== 0) {
			log(
				`bumail: ${name} (port ${port}) arrives in a later slice; not listening`,
			);
		}
	}

	let forced = false;
	let stopping: Promise<void> | undefined;
	const waitUntil = async (done: () => boolean, ms: number) => {
		const end = Date.now() + ms;
		while (!done() && !forced && Date.now() < end) await Bun.sleep(25);
	};
	const smtps = () =>
		started.filter((s) => s.kind === 'smtp').map((s) => s.server as SmtpServer);

	return {
		listening,
		stop({ force = false } = {}) {
			if (force) forced = true;
			stopping ??= (async () => {
				for (const { server, kind } of started) server.stop(kind === 'imap');
				const drainMs = (options.drainSeconds ?? DEFAULT_DRAIN_SECONDS) * 1000;
				await waitUntil(
					() =>
						smtps().every((s) => s.connections === 0) && inflight.size === 0,
					drainMs,
				);
				for (const server of smtps()) server.stop(true);
				await waitUntil(() => inflight.size === 0, SETTLE_MS);
				await opened.close();
				directory.close();
				log('bumail: stopped');
			})();
			return stopping;
		},
	};
}
