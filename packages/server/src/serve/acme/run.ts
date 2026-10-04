import type { AcmeFetch } from '@bumail/acme';
import type { AcmeConfig } from '../../config/types';
import type { Log } from '../log';
import type { Challenge } from './challenge';
import type { AcmeState } from './state';

/**
 * The timings and the network of ACME, for specs to shorten and point at
 * a test CA; the defaults are the server's.
 */
export interface AcmeOptions {
	/** The CA is reached through this (a test CA's root trusted); default the global `fetch`. */
	readonly fetch?: AcmeFetch;
	/** The clock the renewal window is read against; default `new Date()`. */
	now?(): Date;
	/** Milliseconds between two looks at the expiry. Default 12 hours. */
	readonly checkMs?: number;
	/** Up to this many milliseconds are added to each look, at random. Default 1 hour. */
	readonly jitterMs?: number;
	/** The waits between a failed renewal and the next try; the last repeats. Default 10 minutes, 30 minutes, 1, 3 and 6 hours. */
	readonly retryMs?: readonly number[];
	/** The waits between the tries of a first certificate; one try more than waits. Default 10 s, 30 s, 1, 2 and 5 minutes. */
	readonly startRetryMs?: readonly number[];
	/** Milliseconds between two "waiting for a certificate" lines. Default 30 seconds. */
	readonly waitingLogMs?: number;
	/** Milliseconds between two looks at an order or an authorization of the CA. Default 1 second. */
	readonly pollMs?: number;
	/** Milliseconds one try may take. Default 2 minutes. */
	readonly timeoutMs?: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** `AcmeOptions` with every default filled in. */
export function withDefaults(options: AcmeOptions): Required<AcmeOptions> {
	return {
		fetch: options.fetch ?? ((input, init) => fetch(input, init)),
		now: options.now ?? (() => new Date()),
		checkMs: options.checkMs ?? 12 * HOUR,
		jitterMs: options.jitterMs ?? HOUR,
		retryMs: options.retryMs ?? [
			10 * MINUTE,
			30 * MINUTE,
			HOUR,
			3 * HOUR,
			6 * HOUR,
		],
		startRetryMs: options.startRetryMs ?? [
			10_000,
			30_000,
			MINUTE,
			2 * MINUTE,
			5 * MINUTE,
		],
		waitingLogMs: options.waitingLogMs ?? 30_000,
		pollMs: options.pollMs ?? 1000,
		timeoutMs: options.timeoutMs ?? 2 * MINUTE,
	};
}

/** What the first certificate and the renewals share. */
export interface AcmeRun {
	readonly config: AcmeConfig;
	readonly state: AcmeState;
	readonly challenge: Challenge;
	readonly log: Log;
	readonly options: Required<AcmeOptions>;
}

/** A failure on one line, as the log and the exit message say it. */
export function reasonOf(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	const line = text.replace(/\s+/g, ' ').trim();
	return line.length > 400 ? `${line.slice(0, 400)}...` : line;
}

/** Waits `ms`; `false` when `signal` aborted first. */
export function pause(ms: number, signal: AbortSignal): Promise<boolean> {
	return new Promise((resolve) => {
		if (signal.aborted) return resolve(false);
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve(true);
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve(false);
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}
