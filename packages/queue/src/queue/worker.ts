import type { QueueItem } from '../contract/types';
import { QueueError } from '../errors';
import { deliverItem, type Lapse } from './deliver';
import { KeyedLimiter, Limiter } from './limiter';
import type { NotifyContext } from './notify';

/** The lease on an item under delivery, as the worker renewing it knows it. */
interface Lease {
	/** Stops the renewals: the outcome is recorded. */
	readonly stop: () => void;
	readonly lapsed: (now: number) => Promise<Lapse | undefined>;
}

/**
 * Claims due items and delivers them, at most `concurrency` at once,
 * renewing each lease while its item is delivered. `start()` runs passes
 * every `pollInterval`, or at once when woken; `stop()` lets every
 * delivery under way finish and gives back what it had not started.
 */
export class Worker {
	readonly #ctx: NotifyContext;
	readonly #slots: Limiter;
	readonly #domains: KeyedLimiter;
	readonly #inFlight = new Set<Promise<void>>();
	#stopping = false;
	/** `start()` was called while a `stop()` was under way: start again once it ends. */
	#restart = false;
	#loop: Promise<void> | undefined;
	#wake: (() => void) | undefined;
	/** A wake came while no sleep was under way: the next sleep is skipped. */
	#woken = false;

	constructor(ctx: NotifyContext) {
		this.#ctx = ctx;
		this.#slots = new Limiter(ctx.settings.concurrency);
		this.#domains = new KeyedLimiter(ctx.settings.perDomain);
	}

	/**
	 * Renews the lease every third of it until the outcome is recorded, and
	 * keeps what it learns for `lapsed`. A renewal that finds the lease taken
	 * — the item still there, under another worker or none — says so once,
	 * and stops; one that finds the item gone says nothing and stops: a
	 * cancel, or another worker that finished it, which `deliverItem` tells
	 * apart by the lease's expiry. One that fails (the store busy,
	 * unreachable) says so, and the next one tries again: the lease may
	 * still be held.
	 */
	#renewing(item: QueueItem): Lease {
		const { settings, store, events } = this.#ctx;
		let done = false;
		/** The lease's last expiry this worker set: the claim's, then each renewal's. */
		let expiresAt = item.lease?.expiresAt ?? settings.now() + settings.leaseMs;
		/** A renewal found the item still there under another worker, or none. */
		let taken = false;
		/** The look a refused renewal takes at the item, awaited by `lapsed`. */
		let looking: Promise<void> = Promise.resolve();
		const stop = () => {
			done = true;
			clearInterval(timer);
		};
		const refused = async () => {
			const kept = await store.get(item.id);
			if (kept === undefined) return;
			taken = true;
			const error = new QueueError(
				'LEASE_LOST',
				`The lease on ${item.id} was lost while it was delivered`,
			);
			events.emit('error', { error, id: item.id });
		};
		const timer = setInterval(() => {
			const next = settings.now() + settings.leaseMs;
			store.renew(item.id, settings.owner, next).then(
				(held) => {
					if (done) return;
					if (held) {
						expiresAt = next;
						return;
					}
					stop();
					looking = refused().catch((error: unknown) => {
						events.emit('error', { error, id: item.id });
					});
				},
				(error: unknown) => {
					if (!done) events.emit('error', { error, id: item.id });
				},
			);
		}, settings.leaseMs / 3);
		timer.unref?.();
		return {
			stop,
			lapsed: async (now) => {
				await looking;
				if (taken) return 'taken';
				return expiresAt <= now ? 'expired' : undefined;
			},
		};
	}

	async #deliver(item: QueueItem): Promise<void> {
		const lease = this.#renewing(item);
		try {
			await deliverItem(
				{
					...this.#ctx,
					domains: this.#domains,
					stopping: () => this.#stopping,
					recorded: lease.stop,
					leaseLapsed: lease.lapsed,
				},
				item,
			);
		} catch (error) {
			this.#ctx.events.emit('error', { error, id: item.id });
		} finally {
			lease.stop();
		}
	}

	/** The next due item, or `undefined` when nothing is, or the worker is stopping. */
	#claim(): Promise<QueueItem | undefined> {
		const { settings, store } = this.#ctx;
		if (this.#stopping) return Promise.resolve(undefined);
		return store.claim({
			owner: settings.owner,
			now: settings.now(),
			leaseMs: settings.leaseMs,
		});
	}

	/**
	 * One pass: claims and delivers every item due, `concurrency` at a time,
	 * claiming again as each one ends — so a DSN enqueued meanwhile goes in
	 * the same pass. Resolves once all are done, with how many it claimed.
	 */
	async deliverDue(): Promise<number> {
		const mine = new Set<Promise<void>>();
		let claimed = 0;
		while (!this.#stopping) {
			const release = await this.#slots.acquire();
			let item: QueueItem | undefined;
			try {
				item = await this.#claim();
			} catch (error) {
				release();
				await Promise.all(mine);
				throw error;
			}
			if (!item) {
				release();
				if (mine.size === 0) break;
				await Promise.race(mine);
				continue;
			}
			claimed++;
			const delivery: Promise<void> = this.#deliver(item).finally(() => {
				release();
				mine.delete(delivery);
				this.#inFlight.delete(delivery);
			});
			mine.add(delivery);
			this.#inFlight.add(delivery);
		}
		await Promise.all(mine);
		return claimed;
	}

	/** Wakes a sleeping `start()` loop, or spares it its next sleep: something was enqueued. */
	wake(): void {
		if (this.#wake) this.#wake();
		else this.#woken = true;
	}

	start(): void {
		if (this.#stopping) {
			this.#restart = true;
			return;
		}
		if (this.#loop) return;
		this.#loop = this.#run();
	}

	async #sleep(): Promise<void> {
		if (this.#woken) {
			this.#woken = false;
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, this.#ctx.settings.pollInterval);
			this.#wake = () => {
				clearTimeout(timer);
				resolve();
			};
		});
		this.#wake = undefined;
	}

	async #run(): Promise<void> {
		while (!this.#stopping) {
			this.#woken = false;
			try {
				await this.deliverDue();
			} catch (error) {
				this.#ctx.events.emit('error', { error });
			}
			if (this.#stopping) break;
			await this.#sleep();
		}
	}

	/**
	 * Claims nothing more, lets every delivery under way end, and gives back
	 * what was claimed but not started, due at once for the next worker. A
	 * `start()` called meanwhile starts again once this ends.
	 */
	async stop(): Promise<void> {
		this.#restart = false;
		this.#stopping = true;
		this.#wake?.();
		await this.#loop;
		await Promise.all(this.#inFlight);
		this.#loop = undefined;
		this.#stopping = false;
		if (this.#restart) {
			this.#restart = false;
			this.start();
		}
	}
}
