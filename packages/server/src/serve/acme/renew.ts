import type { TlsWatch } from '../reload';
import type { TlsFiles } from '../tls';
import { describeCertificate, leafOf, renewAt } from './certificate';
import { issue } from './issue';
import { type AcmeRun, reasonOf } from './run';

/** A wait in words: seconds under two minutes, else minutes. */
function inWords(ms: number): string {
	return ms < 120_000
		? `${Math.ceil(ms / 1000)} s`
		: `${Math.round(ms / 60_000)} min`;
}

/** The renewal timer, stoppable. */
export interface Renewal {
	/** Stops the timer, and abandons a renewal under way; the old certificate stays. */
	stop(): void;
}

/**
 * Looks at the expiry of the certificate the listeners use every
 * `checkMs` plus a random `jitterMs`. Inside the renewal window
 * (`renewAt`) it obtains a new certificate, writes the pair to the volume,
 * and has `watch` apply it to every listener at once (`reload`): all
 * switch or none does. A failure — the CA's, the disk's, or a listener
 * refusing the pair, in which case the old pair is written back — keeps
 * the old certificate, logs `tls: renewal failed: <reason>`, and tries
 * again after the next of `retryMs`, the last one repeating. Success logs
 * `tls: renewed (<names>; expires <day>)`.
 */
export function startRenewal(
	run: AcmeRun,
	watch: TlsWatch,
	applied: (pair: TlsFiles) => void,
): Renewal {
	const { options, log } = run;
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let failures = 0;

	/** The wait after the `failures`th failure in a row. */
	const retryWait = () =>
		options.retryMs[Math.min(failures, options.retryMs.length) - 1] ??
		options.checkMs;

	const attempt = async (): Promise<void> => {
		const old = watch.applied;
		try {
			const pair = await issue({
				config: run.config,
				state: run.state,
				challenge: run.challenge,
				fetch: options.fetch,
				pollMs: options.pollMs,
				timeoutMs: options.timeoutMs,
				signal: abort.signal,
			});
			await run.state.writePair(pair);
			await watch.reload();
			if (watch.applied.cert !== pair.cert) {
				await run.state.writePair(old);
				throw new Error(
					'the listeners did not take the new certificate; see the line above',
				);
			}
			applied(pair);
			const leaf = leafOf(pair.cert);
			log(`tls: renewed (${leaf ? describeCertificate(leaf) : ''})`);
			failures = 0;
		} catch (error) {
			if (abort.signal.aborted) return;
			failures++;
			log(
				`tls: renewal failed: ${reasonOf(error)}; the current certificate stays, trying again in ${inWords(retryWait())}`,
			);
		}
	};

	const delay = () =>
		failures > 0
			? retryWait()
			: options.checkMs + Math.random() * options.jitterMs;

	const look = async (): Promise<void> => {
		const leaf = leafOf(watch.applied.cert);
		const due =
			leaf === undefined ||
			options.now() >= renewAt(leaf, run.config.renewBeforeDays);
		if (due) await attempt();
		if (abort.signal.aborted) return;
		timer = setTimeout(() => void look(), delay());
		timer.unref();
	};

	// The first look is soon, whatever `checkMs` is: a certificate stored
	// inside its window is renewed at once, not half a day after the start.
	timer = setTimeout(() => void look(), Math.min(options.checkMs, 60_000));
	timer.unref();
	return {
		stop() {
			abort.abort();
			clearTimeout(timer);
		},
	};
}
