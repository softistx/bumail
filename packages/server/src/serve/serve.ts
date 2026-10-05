import type { Resolver } from '@bumail/dns';
import type { ServerConfig } from '../config/types';
import { directoryFile } from '../directory/database';
import { Directory } from '../directory/directory';
import { type OpenedStore, openStore } from '../store/open';
import { Acme, type AcmeOptions, NO_PAIR } from './acme';
import { type Bound, bindAll } from './bind';
import type { ListenerName } from './listeners';
import type { Log } from './log';
import {
	type OpenedQueueStore,
	type OutboundOptions,
	openQueueStore,
} from './outbound';
import { watchCertificate } from './reload';
import { assemble } from './resources';
import { Spool } from './spool';
import { logStart, warnPostmaster } from './start-log';
import { closeResources, stopper } from './stop';
import { readTls } from './tls';

export type { AcmeOptions } from './acme';
export type { ListenerName } from './listeners';

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
	/** With `tls.mode = "acme"`, for specs: the CA's `fetch`, the clock and the timings. */
	readonly acme?: AcmeOptions;
	/**
	 * Aborts the wait for a first certificate (`tls.mode = "acme"` with
	 * none stored): `serve` then rejects with `UNAVAILABLE`, having stopped
	 * what it started. Moot once the listeners are up: `stop` ends those.
	 */
	readonly signal?: AbortSignal;
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
	/**
	 * Looks at `tls.cert` and `tls.key` now — with `tls.mode = "acme"`, at
	 * the pair stored on the volume — as `bumail serve` does on SIGHUP,
	 * and switches every TLS listener to a renewed pair, if there is one;
	 * logs what it found. It never starts a renewal. Resolves once it
	 * looked, whatever it found.
	 */
	reloadTls(): Promise<void>;
}

const defaultLog: Log = (line) => {
	process.stdout.write(`${line}\n`);
};

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

/**
 * Runs the server for `config`: takes the certificate (`tls.mode =
 * "files"`: read from the files; `"acme"`: the pair stored on the volume,
 * or, when there is none, bound port 80 and the health check first, then
 * obtained from the CA before any TLS listener starts), opens the spool,
 * the directory, the mail store and the queue, starts each listener whose
 * port is not 0 — `mx`, `submissions`, `submission`, `imaps`, `imap`,
 * `https`, and `http` with ACME — logging one line each, then the
 * queue's worker. What cannot be opened or bound, or a certificate that
 * does not come, is `ServerError('UNAVAILABLE')`, with whatever was
 * started stopped again.
 */
export async function serve(
	config: ServerConfig,
	options: ServeOptions = {},
): Promise<RunningServer> {
	const log = options.log ?? defaultLog;
	const acme =
		config.acme === undefined
			? undefined
			: new Acme(config, options.acme ?? {}, log);
	const stored = acme?.stored();
	const tls =
		config.tls.mode === 'files' ? readTls(config.tls) : (stored ?? NO_PAIR);
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
		{ config, directory, opened, queueStore, tls, acme, spool, log },
		options,
	);
	const { queue, describe } = resources;

	const bound: Bound = { started: [], listening: [] };
	try {
		await bindAll(
			resources,
			options,
			bound,
			stored === undefined ? acme : undefined,
		);
	} catch (error) {
		for (const { server } of bound.started) server.stop(true);
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
	const tlsWatch =
		acme?.watch(resources, bound.started) ??
		watchCertificate(resources, bound.started);

	return {
		listening: bound.listening,
		reloadTls: () => tlsWatch?.reload() ?? Promise.resolve(),
		stop: stopper({
			listeners: bound.started,
			up: resources.up,
			inflight: resources.inflight,
			storeCalls,
			opened,
			directory,
			queue,
			queueStore,
			spool,
			tlsWatch,
			log,
			describe,
			drainMs: (options.drainSeconds ?? DEFAULT_DRAIN_SECONDS) * 1000,
		}),
	};
}
