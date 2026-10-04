import { cachedResolver, nodeResolver } from '@bumail/dns';
import type { ImapServer } from '@bumail/imap';
import type { Queue } from '@bumail/queue';
import type { ServerConfig } from '../config/types';
import type { Directory } from '../directory/directory';
import { maskedFor, type OpenedStore } from '../store/open';
import type { Delivery, Resources } from './listeners';
import type { Log } from './log';
import {
	createOutbound,
	type OpenedQueueStore,
	type OutboundOptions,
} from './outbound';
import type { ServeOptions } from './serve';
import type { Spool } from './spool';
import { dkimSigner } from './submission/sign';
import type { TlsFiles } from './tls';
import { trackedStore } from './tracked';

/**
 * Milliseconds one DNS try has, and tries per query, for the inbound
 * checks: one query takes 10 s at worst. DKIM, SPF and DMARC are each
 * cut off at 10 s on top of that (`CHECK_TIMEOUT_MS`); SPF runs from
 * MAIL FROM, so a message's checks take 20 s at worst after DATA (DKIM,
 * then DMARC), well within the 60 s the SMTP server gives `onData`.
 */
export const DNS_TIMEOUT_MS = 5000;
export const DNS_TRIES = 2;

/** What `serve` opened, for `assemble` to wire. */
export interface Opened {
	readonly config: ServerConfig;
	readonly directory: Directory;
	readonly opened: OpenedStore;
	readonly queueStore: OpenedQueueStore;
	readonly tls: TlsFiles;
	readonly spool: Spool;
	readonly log: Log;
}

/**
 * Tells the IMAP servers of each delivery, and keeps it under way, so a
 * stop waits for it before closing the store: one for the MX, submission
 * and the queue alike.
 */
export function delivery(
	imaps: readonly ImapServer[],
	inflight: Set<Promise<unknown>>,
): Delivery {
	return {
		onDelivered: (accountId) => {
			for (const imap of imaps) imap.notify(accountId);
		},
		track: (work) => {
			inflight.add(work);
			void work.finally(() => inflight.delete(work)).catch(() => {});
			return work;
		},
	};
}

/** The queue, on the queue store, its own users served from the store. */
function outbound(
	{ config, directory, queueStore, log }: Opened,
	resources: Pick<Resources, 'store' | 'resolver' | 'describe' | 'delivery'>,
	options: OutboundOptions | undefined,
): Queue {
	return createOutbound(
		config,
		queueStore.store,
		{
			hostname: config.hostname,
			directory,
			store: resources.store,
			postmaster: config.postmaster,
			resolver: resources.resolver,
			log,
			describe: (error) =>
				maskedFor(resources.describe(error), config.queue.url),
			...resources.delivery,
		},
		options,
	);
}

/**
 * What the listeners share, wired from what `serve` opened: the store,
 * its calls counted for a stop; the resolver; the delivery hooks; the
 * queue, not yet started; the DKIM signer.
 */
export function assemble(
	opened: Opened,
	options: ServeOptions,
): { resources: Resources; storeCalls: Set<Promise<unknown>> } {
	const { config, directory } = opened;
	const describe = (error: unknown) =>
		maskedFor(
			error instanceof Error ? error.message : String(error),
			config.store.url,
		);
	const storeCalls = new Set<Promise<unknown>>();
	const store = trackedStore(opened.opened.store, storeCalls);
	const resolver =
		options.resolver ??
		cachedResolver(nodeResolver({ timeout: DNS_TIMEOUT_MS, tries: DNS_TRIES }));
	const inflight = new Set<Promise<unknown>>();
	const imaps: ImapServer[] = [];
	const hooks = delivery(imaps, inflight);
	const shared = { store, resolver, describe, delivery: hooks };
	const resources: Resources = {
		config,
		directory,
		tls: opened.tls,
		spool: opened.spool,
		log: opened.log,
		inflight,
		up: new Set(),
		imaps,
		...shared,
		queue: outbound(opened, shared, options.outbound),
		sign: dkimSigner(directory),
	};
	return { resources, storeCalls };
}
