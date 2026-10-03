import type { QueueItem } from '../contract/types';
import { QueueError } from '../errors';
import { type DeliveryContext, deliverItem } from './deliver';
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
	#loop: Promise<void> | undefined;
	#wake: (() => void) | undefined;

	constructor(ctx: NotifyContext) {
		this.#ctx = ctx;
		this.#slots = new Limiter(ctx.settings.concurrency);
		this.#domains = new KeyedLimiter(ctx.settings.perDomain);
	}

	/** The most sessions open at once to one domain so far: for a spec. */
	get domains(): KeyedLimiter {
		return this.#domains;
	}

	get running(): boolean {
		return this.#loop !== undefined;
	}

	#delivery(): DeliveryContext {
		return {
			...this.#ctx,
			domains: this.#domains,
			stopping: () => this.#stopping,
		};
	}

	/** Keeps the lease while the item is delivered: renewed every third of it. */
	async #deliver(item: QueueItem): Promise<void> {
		const { settings, store, events } = this.#ctx;
		const renew = setInterval(() => {
			const expiresAt = settings.now() + settings.leaseMs;
			store.renew(item.id, settings.owner, expiresAt).then(
				(held) => {
					if (held) return;
					const error = new QueueError(
						'LEASE_LOST',
						`The lease on ${item.id} was lost while it was delivered`,
					);
					events.emit('error', { error, id: item.id });
				},
				(error: unknown) => events.emit('error', { error, id: item.id }),
			);
		}, settings.leaseMs / 3);
		renew.unref?.();
		try {
			await deliverItem(this.#delivery(), item);
		} catch (error) {
			events.emit('error', { error, id: item.id });
		} finally {
			clearInterval(renew);
		}
	}

	/**
	 * One pass: claims and delivers every item due, `concurrency` at a time,
	 * claiming again as each one ends — so a DSN enqueued meanwhile goes in
	 * the same pass. Resolves once all are done, with how many it claimed.
	 */
	async deliverDue(): Promise<number> {
		const { settings, store } = this.#ctx;
		const mine = new Set<Promise<void>>();
		let claimed = 0;
		while (!this.#stopping) {
			const release = await this.#slots.acquire();
			let item: QueueItem | undefined;
			try {
				item = this.#stopping
					? undefined
					: await store.claim({
							owner: settings.owner,
							now: settings.now(),
							leaseMs: settings.leaseMs,
						});
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

	/** Wakes a sleeping `start()` loop: something was enqueued. */
	wake(): void {
		this.#wake?.();
	}

	start(): void {
		if (this.#loop) return;
		this.#stopping = false;
		this.#loop = this.#run();
	}

	async #run(): Promise<void> {
		const { settings, events } = this.#ctx;
		while (!this.#stopping) {
			try {
				await this.deliverDue();
			} catch (error) {
				events.emit('error', { error });
			}
			if (this.#stopping) break;
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, settings.pollInterval);
				this.#wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			this.#wake = undefined;
		}
	}

	/**
	 * Claims nothing more, lets every delivery under way end, and gives back
	 * what was claimed but not started, due at once for the next worker.
	 */
	async stop(): Promise<void> {
		this.#stopping = true;
		this.#wake?.();
		await this.#loop;
		await Promise.all(this.#inFlight);
		this.#loop = undefined;
		this.#stopping = false;
	}
}
