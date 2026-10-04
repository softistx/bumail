import type { Resolver } from '@bumail/dns';
import type { ServerConfig } from '../config/types';
import { directoryFile } from '../directory/database';
import { Directory } from '../directory/directory';
import { ServerError } from '../errors';
import { type OpenedStore, openStore } from '../store/open';
import {
	createListener,
	DESCRIPTION,
	LATER,
	LISTENERS,
	type Listener,
	type ListenerName,
	type Resources,
} from './listeners';
import type { Log } from './log';
import {
	type OpenedQueueStore,
	type OutboundOptions,
	openQueueStore,
} from './outbound';
import { envelopeDomain } from './recipients';
import { assemble } from './resources';
import { Spool } from './spool';
import { closeResources, stopper } from './stop';
import { readTls } from './tls';

export { LATER, type ListenerName } from './listeners';

/** Seconds a stop waits for SMTP sessions to end, by default. */
export const DEFAULT_DRAIN_SECONDS = 10;

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
	/** The queue's network, for specs: the port of MX hosts, a CA to trust, how often it looks. */
	readonly outbound?: OutboundOptions;
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

/** Bun's reason for a bind that failed, with its code when the message leaves it out. */
function bindReason(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const code = (error as { code?: unknown } | undefined)?.code;
	return typeof code === 'string' && !message.includes(code)
		? `${message}: ${code}`
		: message;
}

/** The directory, the store and the queue's, opened; those opened closed again when one fails. */
async function openResources(config: ServerConfig): Promise<{
	directory: Directory;
	opened: OpenedStore;
	queueStore: OpenedQueueStore;
}> {
	const directory = Directory.open({
		file: directoryFile(config.directory.url),
	});
	let opened: OpenedStore | undefined;
	try {
		opened = openStore(config.store);
		return { directory, opened, queueStore: openQueueStore(config.queue) };
	} catch (error) {
		await opened?.close().catch(() => {});
		directory.close();
		throw error;
	}
}

/** Binds each listener of `resources` whose port is not 0; on a failure, stops those bound and throws `UNAVAILABLE`. */
async function bindListeners(
	resources: Resources,
	options: ServeOptions,
): Promise<{ started: Listener[]; listening: Listening[] }> {
	const { config } = resources;
	const started: Listener[] = [];
	const listening: Listening[] = [];
	for (const name of LISTENERS) {
		const configured = config.ports[name];
		if (configured === 0) continue;
		const port = options.port?.(name, configured) ?? configured;
		const listener = createListener(name, resources);
		try {
			const bound = await listener.server.listen({
				port,
				hostname: config.bind,
			});
			listening.push({ name, ...bound });
		} catch (error) {
			for (const { server } of started) server.stop(true);
			throw new ServerError(
				'UNAVAILABLE',
				`${name} cannot listen on ${config.bind}:${port} (${bindReason(error)})`,
			);
		}
		started.push(listener);
		if (listener.kind === 'imap') resources.imaps.push(listener.server);
	}
	return { started, listening };
}

/** The start's log: the server's name, one line per listener, one per port arriving later. */
function logStart(
	config: ServerConfig,
	listening: readonly Listening[],
	log: Log,
): void {
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
}

/**
 * Warns when `postmaster` is in a domain the server does not host: the
 * bare `<postmaster>` goes nowhere, and is refused, until it is.
 */
function warnPostmaster(
	config: ServerConfig,
	directory: Directory,
	log: Log,
): void {
	const { postmaster } = config;
	if (postmaster === undefined) return;
	const domain = envelopeDomain(postmaster);
	if (directory.domains.has(domain)) return;
	log(
		`bumail: postmaster ${postmaster} is in ${domain}, a domain not hosted here; mail for <postmaster> is refused until it is`,
	);
}

/**
 * Runs the server for `config`: reads the certificate (`tls.mode =
 * "files"`; `"acme"` is `NOT_IMPLEMENTED`), opens the spool, the
 * directory, the mail store and the queue, starts each listener whose
 * port is not 0 — `mx`, `submissions`, `submission`, `imaps`, `imap` —
 * logging one line each, then the queue's worker. The other ports
 * are logged as arriving later, and bound to nothing. What cannot be
 * opened or bound is `ServerError('UNAVAILABLE')`, with whatever was
 * started stopped again.
 */
export async function serve(
	config: ServerConfig,
	options: ServeOptions = {},
): Promise<RunningServer> {
	const log = options.log ?? defaultLog;
	const tls = readTls(config.tls);
	const spool = Spool.open(config.data, config.inbound.spoolBytes, { log });
	let directory: Directory;
	let opened: OpenedStore;
	let queueStore: OpenedQueueStore;
	try {
		({ directory, opened, queueStore } = await openResources(config));
	} catch (error) {
		spool.close();
		throw error;
	}
	const { resources, storeCalls } = assemble(
		{ config, directory, opened, queueStore, tls, spool, log },
		options,
	);
	const { queue, describe } = resources;

	let bound: Awaited<ReturnType<typeof bindListeners>>;
	try {
		bound = await bindListeners(resources, options);
	} catch (error) {
		await closeResources({ opened, directory, queueStore }, log, describe);
		spool.close();
		throw error;
	}
	queue.start();
	logStart(config, bound.listening, log);
	for (const { path, reason } of spool.kept) {
		log(`bumail: the spool folder ${path} is kept: ${reason}`);
	}
	warnPostmaster(config, directory, log);

	return {
		listening: bound.listening,
		stop: stopper({
			listeners: bound.started,
			inflight: resources.inflight,
			storeCalls,
			opened,
			directory,
			queue,
			queueStore,
			spool,
			log,
			describe,
			drainMs: (options.drainSeconds ?? DEFAULT_DRAIN_SECONDS) * 1000,
		}),
	};
}
