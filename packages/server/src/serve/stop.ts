import type { Queue } from '@bumail/queue';
import type { SmtpServer } from '@bumail/smtp';
import type { Directory } from '../directory/directory';
import type { OpenedStore } from '../store/open';
import type { HttpListener } from './http/listener';
import type { Listener, ListenerName } from './listeners';
import type { Log } from './log';
import type { OpenedQueueStore } from './outbound';
import type { Spool } from './spool';

/** Milliseconds a stop waits, after the drain, for deliveries already writing to the store. */
export const SETTLE_MS = 5000;

/** What a stop closes. */
export interface Running {
	readonly listeners: readonly Listener[];
	/** The health check's view of the listeners: cleared as the stop begins. */
	readonly up: Set<ListenerName>;
	readonly inflight: ReadonlySet<Promise<unknown>>;
	/** Store calls under way, IMAP's included. */
	readonly storeCalls: ReadonlySet<Promise<unknown>>;
	readonly opened: OpenedStore;
	readonly directory: Directory;
	readonly queue: Queue;
	readonly queueStore: OpenedQueueStore;
	readonly spool: Spool;
	/** The watch on the certificate files, which a stop ends first. */
	readonly tlsWatch?: { stop(): void } | undefined;
	readonly log: Log;
	describe(error: unknown): string;
	/** Milliseconds SMTP sessions are given to end. */
	readonly drainMs: number;
}

/** Closes the queue store, the mail store, then the directory, whatever a close throws. */
export async function closeResources(
	resources: {
		readonly opened: OpenedStore;
		readonly directory: Directory;
		readonly queueStore: OpenedQueueStore | undefined;
	},
	log: Log,
	describe: (error: unknown) => string,
): Promise<void> {
	try {
		await resources.queueStore?.close();
	} catch (error) {
		log(`bumail: the queue did not close cleanly: ${describe(error)}`);
	}
	try {
		await resources.opened.close();
	} catch (error) {
		log(`bumail: the mail store did not close cleanly: ${describe(error)}`);
	} finally {
		resources.directory.close();
	}
}

/**
 * The stop of a running server: listeners stopped, the queue claiming
 * nothing more, IMAP sessions closed, SMTP sessions and the requests of JMAP
 * and the health check drained for `drainMs`
 * then closed, deliveries, store calls and the queue's deliveries under
 * way given `SETTLE_MS`, then the queue, the store and the directory
 * closed. The queue gives back what it claimed and did not start; a
 * delivery still under way past the wait keeps its lease, which lapses,
 * so the item is tried again. Called again, it answers the same promise;
 * `force` skips the waits, even one under way.
 */
export function stopper(
	running: Running,
): (options?: { readonly force?: boolean }) => Promise<void> {
	let forced = false;
	let stopping: Promise<void> | undefined;
	const waitUntil = async (done: () => boolean, ms: number) => {
		const end = Date.now() + ms;
		while (!done() && !forced && Date.now() < end) await Bun.sleep(25);
	};
	const smtps: SmtpServer[] = [];
	const https: HttpListener[] = [];
	for (const l of running.listeners) {
		if (l.kind === 'smtp') smtps.push(l.server);
		if (l.kind === 'http') https.push(l.server);
	}
	return ({ force = false } = {}) => {
		if (force) forced = true;
		stopping ??= (async () => {
			running.tlsWatch?.stop();
			running.up.clear();
			for (const { server, kind } of running.listeners)
				server.stop(kind === 'imap');
			let queueStopped = false;
			void running.queue
				.stop()
				.catch((error: unknown) =>
					running.log(
						`bumail: the queue did not stop cleanly: ${running.describe(error)}`,
					),
				)
				.finally(() => {
					queueStopped = true;
				});
			await waitUntil(
				() =>
					smtps.every((s) => s.connections === 0) &&
					https.every((h) => h.pending === 0) &&
					running.inflight.size === 0,
				running.drainMs,
			);
			for (const server of smtps) server.stop(true);
			for (const server of https) server.stop(true);
			// Deliveries, and IMAP commands cut off with their sessions, finish
			// the store calls they are in before the store closes.
			await waitUntil(
				() =>
					running.inflight.size === 0 &&
					running.storeCalls.size === 0 &&
					queueStopped,
				SETTLE_MS,
			);
			if (!queueStopped) {
				running.log(
					'bumail: queue deliveries still under way are left to their leases',
				);
			}
			await closeResources(running, running.log, (error) =>
				running.describe(error),
			);
			running.spool.close();
			running.log('bumail: stopped');
		})();
		return stopping;
	};
}
