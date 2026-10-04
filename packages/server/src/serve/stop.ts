import type { SmtpServer } from '@bumail/smtp';
import type { Directory } from '../directory/directory';
import type { OpenedStore } from '../store/open';
import type { Listener } from './listeners';
import type { Log } from './log';
import type { Spool } from './spool';

/** Milliseconds a stop waits, after the drain, for deliveries already writing to the store. */
export const SETTLE_MS = 5000;

/** What a stop closes. */
export interface Running {
	readonly listeners: readonly Listener[];
	readonly inflight: ReadonlySet<Promise<unknown>>;
	/** Store calls under way, IMAP's included. */
	readonly storeCalls: ReadonlySet<Promise<unknown>>;
	readonly opened: OpenedStore;
	readonly directory: Directory;
	readonly spool: Spool;
	readonly log: Log;
	describe(error: unknown): string;
	/** Milliseconds SMTP sessions are given to end. */
	readonly drainMs: number;
}

/** Closes the store, then the directory, whatever the store's close throws. */
export async function closeResources(
	opened: OpenedStore,
	directory: Directory,
	log: Log,
	describe: (error: unknown) => string,
): Promise<void> {
	try {
		await opened.close();
	} catch (error) {
		log(`bumail: the mail store did not close cleanly: ${describe(error)}`);
	} finally {
		directory.close();
	}
}

/**
 * The stop of a running server: listeners stopped, IMAP sessions closed,
 * SMTP sessions drained for `drainMs` then closed, deliveries and store
 * calls under way given `SETTLE_MS`, the store and the directory closed. Called again, it
 * answers the same promise; `force` skips the waits, even one under way.
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
	for (const l of running.listeners)
		if (l.kind === 'smtp') smtps.push(l.server);
	return ({ force = false } = {}) => {
		if (force) forced = true;
		stopping ??= (async () => {
			for (const { server, kind } of running.listeners)
				server.stop(kind === 'imap');
			await waitUntil(
				() =>
					smtps.every((s) => s.connections === 0) &&
					running.inflight.size === 0,
				running.drainMs,
			);
			for (const server of smtps) server.stop(true);
			// Deliveries, and IMAP commands cut off with their sessions, finish
			// the store calls they are in before the store closes.
			await waitUntil(
				() => running.inflight.size === 0 && running.storeCalls.size === 0,
				SETTLE_MS,
			);
			await closeResources(
				running.opened,
				running.directory,
				running.log,
				(error) => running.describe(error),
			);
			running.spool.close();
			running.log('bumail: stopped');
		})();
		return stopping;
	};
}
