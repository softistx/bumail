import { shown } from '../encoding';
import { AcmeError } from '../errors';
import { untilAborted } from './failure';

/** How long the removes may take in all: they run even after the flow's time is up. */
export const REMOVE_GRACE_MS = 10_000;

/** The hooks that publish an HTTP-01 answer: `http01Responder()` is one. */
export interface Http01Hooks {
	/** Serve `keyAuthorization` at `http://<name>/.well-known/acme-challenge/<token>`, on port 80. */
	set(token: string, keyAuthorization: string): void | Promise<void>;
	/** Stop serving it. Called for every token `set` was called with, whatever happened. */
	remove(token: string): void | Promise<void>;
}

/**
 * The tokens a flow set through the hooks, each with its `set` call, so
 * every one can be removed — after its `set` settled, even when the flow
 * stopped waiting for it: a `set` that lands after its `remove` would
 * leave the token served.
 */
export class Http01Tokens {
	readonly #hooks: Http01Hooks;
	readonly #graceMs: number;
	readonly #sets = new Map<string, Promise<void>>();

	constructor(hooks: Http01Hooks, graceMs = REMOVE_GRACE_MS) {
		this.#hooks = hooks;
		this.#graceMs = graceMs;
	}

	/** Calls `set`, waiting for it as long as `signal` holds; it is remembered either way. */
	async set(
		token: string,
		keyAuthorization: string,
		signal: AbortSignal,
	): Promise<void> {
		const setting = (async () => {
			await this.#hooks.set(token, keyAuthorization);
		})();
		this.#sets.set(token, setting);
		await untilAborted(setting, signal);
	}

	/**
	 * Removes every token, all at once within one grace (`REMOVE_GRACE_MS`): each
	 * `remove` waits for its `set` to settle first, then runs; a `set` still
	 * pending at the end of the grace gets its `remove` then, unwaited. The
	 * first failure, if any: a hook that threw, or one that did not settle
	 * in time.
	 */
	async removeAll(): Promise<{ error: unknown } | undefined> {
		const grace = AbortSignal.timeout(this.#graceMs);
		const results = await Promise.allSettled(
			[...this.#sets].map(async ([token, setting]) => {
				try {
					await untilAborted(
						setting.catch(() => {}),
						grace,
					);
				} catch (error) {
					// still asked, at once and unwaited: it may land before the set does
					void (async () => this.#hooks.remove(token))().catch(() => {});
					throw new AcmeError(
						'TIMEOUT',
						`obtainCertificate(): http01.set(${shown(token)}) did not settle within ${this.#graceMs} ms, so its token may stay served`,
						{ cause: error },
					);
				}
				const removing = (async () => {
					await this.#hooks.remove(token);
				})();
				try {
					await untilAborted(removing, grace);
				} catch (error) {
					if (!grace.aborted) throw error;
					throw new AcmeError(
						'TIMEOUT',
						`obtainCertificate(): http01.remove(${shown(token)}) did not settle within ${this.#graceMs} ms`,
						{ cause: error },
					);
				}
			}),
		);
		this.#sets.clear();
		const failed = results.find(
			(result): result is PromiseRejectedResult => result.status === 'rejected',
		);
		return failed === undefined ? undefined : { error: failed.reason };
	}
}
