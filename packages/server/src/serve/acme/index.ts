import type { ServerConfig } from '../../config/types';
import { ServerError } from '../../errors';
import type { Listener, Resources } from '../listeners';
import type { Log } from '../log';
import { heldOf, type TlsWatch, targetsOf, watchTls } from '../reload';
import type { TlsFiles } from '../tls';
import { describeCertificate, leafOf, problemWith } from './certificate';
import { type Challenge, createChallenge } from './challenge';
import { firstCertificate } from './first';
import { type Renewal, startRenewal } from './renew';
import { type AcmeOptions, type AcmeRun, reasonOf, withDefaults } from './run';
import { AcmeState } from './state';

export type { AcmeOptions } from './run';

/** Where a pair waits before the first certificate comes: no listener is created with it. */
export const NO_PAIR: TlsFiles = { cert: '', key: '' };

/**
 * `tls.mode = "acme"`, running: the certificate kept on the volume, the
 * port 80 listener's challenges, the first certificate and its renewals.
 */
export class Acme {
	readonly #run: AcmeRun;
	readonly #config: ServerConfig;
	#current: TlsFiles | undefined;

	constructor(config: ServerConfig, options: AcmeOptions, log: Log) {
		if (config.acme === undefined) {
			throw new Error('Acme needs tls.mode "acme"');
		}
		this.#config = config;
		this.#run = {
			config: config.acme,
			state: new AcmeState(config.acme.dir),
			challenge: createChallenge({ hostname: config.hostname, log }),
			log,
			options: withDefaults(options),
		};
	}

	/** The listener of `ports.http`. */
	get challenge(): Challenge {
		return this.#run.challenge;
	}

	/** `up` while a certificate that has not expired is in use, `down` before the first and past the end of the last. */
	get tls(): 'up' | 'down' {
		const leaf = this.#current && leafOf(this.#current.cert);
		return leaf !== undefined && new Date(leaf.validTo) > new Date()
			? 'up'
			: 'down';
	}

	/**
	 * The pair stored on the volume when it is usable now for every name,
	 * else `undefined`, saying why in the log. A certificate inside its
	 * renewal window is still used: the renewal replaces it.
	 */
	stored(): TlsFiles | undefined {
		const { log, config, state } = this.#run;
		let pair: TlsFiles | undefined;
		let previous: TlsFiles | undefined;
		try {
			state.removeStaleTemporaries();
			pair = state.readPair();
			previous = state.readPrevious();
		} catch (error) {
			throw new ServerError(
				'UNAVAILABLE',
				`the certificate in ${state.dir} cannot be read (${reasonOf(error)})`,
			);
		}
		const problem =
			pair === undefined
				? undefined
				: problemWith(pair, config.names, new Date());
		if (pair !== undefined && problem === undefined) return this.#use(pair);
		const why =
			pair === undefined
				? `no certificate stored in ${state.dir}`
				: `the stored certificate is not used: ${problem}`;
		if (
			previous !== undefined &&
			problemWith(previous, config.names, new Date()) === undefined
		) {
			// A crash between the two renames of a renewal leaves a pair that
			// is not one; the pair before it is whole.
			log(`tls: ${why}; using the previous pair`);
			state.restorePrevious();
			return this.#use(previous);
		}
		log(`tls: ${why}`);
		return undefined;
	}

	#use(pair: TlsFiles): TlsFiles {
		const leaf = leafOf(pair.cert);
		this.#run.log(
			`tls: using the stored certificate (${leaf ? describeCertificate(leaf) : ''})`,
		);
		this.#current = pair;
		return pair;
	}

	/** Obtains the first certificate, with retries; throws `UNAVAILABLE` when none comes. */
	async first(signal: AbortSignal): Promise<TlsFiles> {
		const pair = await firstCertificate(this.#run, signal);
		this.#current = pair;
		return pair;
	}

	/**
	 * Starts the renewals, and answers what applies a pair from the volume
	 * to every TLS listener of `started`: the same `watchTls` that takes a
	 * renewed pair of files, with no polling. Its `reload` is SIGHUP's: it
	 * reads the stored pair, and never forces a renewal.
	 */
	watch(resources: Resources, started: readonly Listener[]): TlsWatch {
		const { state, log } = this.#run;
		const watch = watchTls({
			files: { cert: state.certFile, key: state.keyFile, pollSeconds: 0 },
			hostname: this.#config.hostname,
			names: this.#run.config.names,
			labels: { cert: state.certFile, key: state.keyFile },
			applied: resources.tls,
			targets: targetsOf(started),
			held: heldOf(this.#config),
			log,
			describe: resources.describe,
		});
		const renewal: Renewal = startRenewal(this.#run, watch, (pair) => {
			this.#current = pair;
		});
		return {
			get applied() {
				return watch.applied;
			},
			reload: async () => {
				await watch.reload();
				this.#current = watch.applied;
			},
			stop() {
				renewal.stop();
				watch.stop();
			},
		};
	}
}
