import { ServerError } from '../../errors';
import type { TlsFiles } from '../tls';
import { describeCertificate, leafOf } from './certificate';
import { issue } from './issue';
import { type AcmeRun, pause, reasonOf } from './run';

/**
 * The first certificate, when none is stored: tries, waiting between the
 * tries, one more than `startRetryMs` has waits. It logs `tls: waiting
 * for a certificate from <directory>` at once and every `waitingLogMs`,
 * `tls: obtaining a certificate failed (try n of m): <reason>` after each
 * failure, and `tls: obtained (<names>; expires <day>)` with the pair
 * written to the volume. After the last failure, or when `signal` aborts,
 * it throws `UNAVAILABLE`.
 */
export async function firstCertificate(
	run: AcmeRun,
	signal: AbortSignal,
): Promise<TlsFiles> {
	const { config, log, options } = run;
	const tries = options.startRetryMs.length + 1;
	const waiting = () =>
		log(`tls: waiting for a certificate from ${config.directory}`);
	waiting();
	const ticker = setInterval(waiting, options.waitingLogMs);
	try {
		for (let attempt = 1; ; attempt++) {
			try {
				const pair = await issue({
					config,
					state: run.state,
					challenge: run.challenge,
					fetch: options.fetch,
					pollMs: options.pollMs,
					timeoutMs: options.timeoutMs,
					signal,
				});
				await run.state.writePair(pair);
				const leaf = leafOf(pair.cert);
				log(
					`tls: obtained (${leaf ? describeCertificate(leaf) : config.names.join(', ')})`,
				);
				return pair;
			} catch (error) {
				if (signal.aborted) {
					throw new ServerError(
						'UNAVAILABLE',
						'stopped while waiting for a certificate',
					);
				}
				const reason = reasonOf(error);
				log(
					`tls: obtaining a certificate failed (try ${attempt} of ${tries}): ${reason}`,
				);
				if (attempt === tries) {
					throw new ServerError(
						'UNAVAILABLE',
						`no certificate for ${config.names.join(', ')} from ${config.directory} after ${tries} tries: ${reason}. Check that each name resolves to this host and that port 80 (ports.http) reaches it`,
					);
				}
				const wait = options.startRetryMs[attempt - 1] ?? 0;
				if (!(await pause(wait, signal))) {
					throw new ServerError(
						'UNAVAILABLE',
						'stopped while waiting for a certificate',
					);
				}
			}
		}
	} finally {
		clearInterval(ticker);
	}
}
