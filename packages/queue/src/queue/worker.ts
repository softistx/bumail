import type { QueueItem } from '../contract/types';
import { QueueError } from '../errors';
import { deliverItem } from './deliver';
import { KeyedLimiter, Limiter } from './limiter';
import type { NotifyContext } from './notify';

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
	 * Renews the lease every third of it until the outcome is recorded; a
	 * renewal that finds the lease taken says so once, and stops.
	 */
	#renewing(item: QueueItem): () => void {
		const { settings, store, events } = this.#ctx;
		let done = false;
		const stop = () => {
			done = true;
			clearInterval(timer);
		};
		const lost = (error: unknown) => {
			if (done) return;
			stop();
			events.emit('error', { error, id: item.id });
		};
		const timer = setInterval(() => {
			const expiresAt = settings.now() + settings.leaseMs;
			store.renew(item.id, settings.owner, expiresAt).then((held) => {
				if (held) return;
				lost(
					new QueueError(
						'LEASE_LOST',
						`The lease on ${item.id} was lost while it was delivered`,
					),
				);
			}, lost);
		}, settings.leaseMs / 3);
		timer.unref?.();
		return stop;
	}

	async #deliver(item: QueueItem): Promise<void> {
		const stopRenewing = this.#renewing(item);
		try {
			await deliverItem(
				{
					...this.#ctx,
					domains: this.#domains,
					stopping: () => this.#stopping,
					recorded: stopRenewing,
				},
				item,
			);
		} catch (error) {
			this.#ctx.events.emit('error', { error, id: item.id });
		} finally {
			stopRenewing();
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
