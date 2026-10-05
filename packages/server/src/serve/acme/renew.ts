import type { TlsWatch } from '../reload';
import type { TlsFiles } from '../tls';
import { describeCertificate, leafOf, renewAt } from './certificate';
import { issue } from './issue';
import { type AcmeRun, inWords, reasonOf, retryAfterMs } from './run';

/** The renewal timer, stoppable. */
export interface Renewal {
	/** Stops the timer, and abandons a renewal under way; the old certificate stays. */
	stop(): void;
}

/**
 * What the renewal functions share: the run, the watch that applies a
 * pair, and the timer's state. Plain data; the behaviour is in the
 * functions below.
 */
export interface RenewalContext {
	readonly run: AcmeRun;
	readonly watch: TlsWatch;
	/** Told of each pair applied. */
	readonly applied: (pair: TlsFiles) => void;
	readonly abort: AbortController;
	/** Failures in a row, and the last one's `Retry-After`, in milliseconds. */
	failures: number;
	asked: number;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Obtains a certificate; a spec gives its own. */
	readonly issue: typeof issue;
}

/** The wait after the latest failure: the next of `retryMs`, or the CA's own if longer. */
export function retryWait(ctx: RenewalContext): number {
	const { retryMs, checkMs } = ctx.run.options;
	const scheduled = retryMs[Math.min(ctx.failures, retryMs.length) - 1];
	return Math.max(scheduled ?? checkMs, ctx.asked);
}

/** The wait before the next look: the retry's after a failure, else `checkMs` and a random `jitterMs`. */
export function nextDelay(ctx: RenewalContext): number {
	const { checkMs, jitterMs } = ctx.run.options;
	return ctx.failures > 0 ? retryWait(ctx) : checkMs + Math.random() * jitterMs;
}

/**
 * One renewal: obtain a pair, write it to the volume, have the watch
 * apply it to every listener, and write the old pair back if one refused.
 * Logs `tls: renewed (…)` or `tls: renewal failed: …`.
 */
export async function attempt(ctx: RenewalContext): Promise<void> {
	const { run, watch, abort } = ctx;
	const { options, log } = run;
	const old = watch.applied;
	try {
		const pair = await ctx.issue({
			config: run.config,
			state: run.state,
			challenge: run.challenge,
			fetch: options.fetch,
			pollMs: options.pollMs,
			timeoutMs: options.timeoutMs,
			signal: abort.signal,
		});
		run.state.writePair(pair);
		await watch.reload();
		if (watch.applied.cert !== pair.cert) {
			run.state.writePair(old);
			throw new Error(
				'the listeners did not take the new certificate; see the line above',
			);
		}
		ctx.applied(pair);
		const leaf = leafOf(pair.cert);
		log(`tls: renewed (${leaf ? describeCertificate(leaf) : ''})`);
		ctx.failures = 0;
		ctx.asked = 0;
	} catch (error) {
		if (abort.signal.aborted) return;
		ctx.failures++;
		ctx.asked = retryAfterMs(error);
		log(
			`tls: renewal failed: ${reasonOf(error)}; the current certificate stays, trying again in ${inWords(retryWait(ctx))}`,
		);
	}
}

/** Renews when the certificate in use is inside its window, then arms the next look. */
export async function look(ctx: RenewalContext): Promise<void> {
	const { run, watch, abort } = ctx;
	const leaf = leafOf(watch.applied.cert);
	const due =
		leaf === undefined ||
		run.options.now() >= renewAt(leaf, run.config.renewBeforeDays);
	if (due) await attempt(ctx);
	if (!abort.signal.aborted) arm(ctx, nextDelay(ctx));
}

function arm(ctx: RenewalContext, ms: number): void {
	ctx.timer = setTimeout(() => void look(ctx), ms);
	ctx.timer.unref();
}

/**
 * Looks at the expiry of the certificate the listeners use every
 * `checkMs` plus a random `jitterMs`, the first look about a minute after
 * the start, so a certificate stored inside its window is renewed at once.
 */
export function startRenewal(
	run: AcmeRun,
	watch: TlsWatch,
	applied: (pair: TlsFiles) => void,
	issuer: typeof issue = issue,
): Renewal {
	const ctx: RenewalContext = {
		run,
		watch,
		applied,
		abort: new AbortController(),
		failures: 0,
		asked: 0,
		timer: undefined,
		issue: issuer,
	};
	arm(ctx, Math.min(run.options.checkMs, 60_000));
	return {
		stop() {
			ctx.abort.abort();
			clearTimeout(ctx.timer);
		},
	};
}
