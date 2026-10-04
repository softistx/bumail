import type { X509Certificate } from 'node:crypto';
import { Checker } from '../config/checker';
import { readText } from '../config/files';
import { checkTlsPair } from '../config/tls';
import type { ServerConfig } from '../config/types';
import type { Listener, Resources } from './listeners';
import type { Log } from './log';
import type { TlsFiles } from './tls';

/** A listener that takes a renewed pair, by the name its log lines use. */
export interface TlsTarget {
	readonly name: string;
	setTls(tls: TlsFiles): Promise<void>;
}

/** The listeners that run TLS: every mail listener, and JMAP when it ends TLS itself. */
export function targetsOf(listeners: readonly Listener[]): TlsTarget[] {
	return listeners.flatMap(({ name, server }) => {
		const setTls = server.setTls?.bind(server);
		return setTls === undefined ? [] : [{ name, setTls }];
	});
}

/** What watching the certificate files needs. */
export interface WatchOptions {
	/** Where the pair is read from, and how often. */
	readonly files: {
		readonly cert: string;
		readonly key: string;
		readonly pollSeconds: number;
	};
	/** The server's name, which the certificate must carry. */
	readonly hostname: string;
	/** The pair the listeners started with. */
	readonly applied: TlsFiles;
	readonly targets: readonly TlsTarget[];
	/** Names of TLS listeners that keep the old pair until a restart, said in the log. */
	readonly held?: readonly string[];
	readonly log: Log;
	/** A failure's text, any secret in it masked. */
	describe(error: unknown): string;
	/** The time a certificate is checked against; default the clock. */
	now?(): Date;
}

/** The certificate files, watched. */
export interface TlsWatch {
	/**
	 * Looks at the files now, as a SIGHUP does, and says what it found even
	 * when nothing changed. Looks never overlap: this one waits for the one
	 * under way.
	 */
	reload(): Promise<void>;
	/** The pair every listener uses now. */
	readonly applied: TlsFiles;
	/** Looks no more; one under way finishes. */
	stop(): void;
}

/**
 * How a certificate is named in the log: its subject on one line, or,
 * when it has none — Let's Encrypt's certificates have an empty subject
 * — its DNS names.
 */
function subjectOf(certificate: X509Certificate): string {
	const subject = certificate.subject as string | undefined;
	if (subject !== undefined && subject !== '') {
		return subject.split('\n').join(', ');
	}
	return (certificate.subjectAltName ?? '')
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry.startsWith('DNS:'))
		.join(', ');
}

/**
 * Watches `tls.cert` and `tls.key` for a renewed pair, every `pollSeconds`
 * and on `reload()`. Docker bind mounts and the symlink swaps of certbot
 * and Traefik often raise no inotify event, so the files are read and
 * compared with what the listeners use, which a touch that changed nothing
 * does not reload. A pair is taken only once both files can be read and
 * form a valid pair for `hostname` (a key written before its certificate
 * waits), and only if every listener takes it: one that fails puts the
 * listeners already switched back. The log has one line per change —
 * `tls: reloaded (...)` or `tls: not reloaded: <reason>`, the old pair
 * kept — never one per look.
 */
export function watchTls(options: WatchOptions): TlsWatch {
	return new CertificateWatch(options);
}

class CertificateWatch implements TlsWatch {
	readonly #options: WatchOptions;
	readonly #timer: ReturnType<typeof setInterval> | undefined;
	#applied: TlsFiles;
	/** The reason of the last failure logged: a look that finds it again is quiet. */
	#failed: string | undefined;
	#queue: Promise<void> = Promise.resolve();
	/** An explicit look waiting behind the one under way: a SIGHUP meanwhile joins it. */
	#waiting: { promise: Promise<void>; explicit: boolean } | undefined;
	#stopped = false;

	constructor(options: WatchOptions) {
		this.#options = options;
		this.#applied = options.applied;
		const { pollSeconds } = options.files;
		this.#timer =
			pollSeconds > 0
				? setInterval(() => void this.#run(false), pollSeconds * 1000)
				: undefined;
		this.#timer?.unref();
	}

	get applied(): TlsFiles {
		return this.#applied;
	}

	reload(): Promise<void> {
		return this.#stopped ? Promise.resolve() : this.#run(true);
	}

	stop(): void {
		this.#stopped = true;
		clearInterval(this.#timer);
	}

	#run(explicit: boolean): Promise<void> {
		if (this.#stopped) return this.#queue;
		// A look already waiting its turn will read the files as they are
		// when it runs: this one joins it, and it says what it found.
		if (this.#waiting) {
			this.#waiting.explicit ||= explicit;
			return this.#waiting.promise;
		}
		const waiting = {
			explicit,
			promise: Promise.resolve(),
		};
		waiting.promise = this.#queue.then(() => {
			this.#waiting = undefined;
			return this.#look(waiting.explicit).catch((error: unknown) =>
				this.#refuse(this.#options.describe(error), waiting.explicit),
			);
		});
		this.#waiting = waiting;
		this.#queue = waiting.promise;
		return waiting.promise;
	}

	#refuse(reason: string, explicit: boolean): void {
		if (explicit || reason !== this.#failed) {
			this.#options.log(`tls: not reloaded: ${reason}`);
		}
		this.#failed = reason;
	}

	async #look(explicit: boolean): Promise<void> {
		const { files, hostname, log } = this.#options;
		const checker = new Checker();
		const cert = readText(checker, files.cert, 'tls.cert');
		const key = readText(checker, files.key, 'tls.key');
		const certificate = checkTlsPair(
			checker,
			{ cert: cert ?? '', key: key ?? '' },
			{ cert: cert !== undefined, key: key !== undefined },
			hostname,
			this.#options.now?.() ?? new Date(),
		);
		const unchanged = cert === this.#applied.cert && key === this.#applied.key;
		if (unchanged) this.#failed = undefined;
		if (checker.problems.length > 0 && !unchanged) {
			const reason = checker.problems
				.map(({ path, problem }) => `${path} ${problem}`)
				.join('; ');
			return this.#refuse(reason, explicit);
		}
		if (certificate === undefined || cert === undefined || key === undefined) {
			return;
		}
		const expires = new Date(certificate.validTo).toISOString().slice(0, 10);
		const named = `${subjectOf(certificate)}, expires ${expires}`;
		if (unchanged) {
			if (explicit) log(`tls: unchanged (${named})`);
			return;
		}
		const next = { cert, key };
		const failure = await this.#apply(next);
		if (failure !== undefined) return this.#refuse(failure, explicit);
		this.#applied = next;
		this.#failed = undefined;
		const held = this.#options.held ?? [];
		const keeps =
			held.length === 0
				? ''
				: `; ${held.join(', ')} keeps the old certificate until restart`;
		log(`tls: reloaded (${named})${keeps}`);
	}

	/** `pair` on every listener, or the reason one refused, the others back on the old pair. */
	async #apply(pair: TlsFiles): Promise<string | undefined> {
		const done: TlsTarget[] = [];
		for (const target of this.#options.targets) {
			try {
				await target.setTls(pair);
				done.push(target);
			} catch (error) {
				const stuck: string[] = [];
				for (const back of done) {
					await back.setTls(this.#applied).catch(() => stuck.push(back.name));
				}
				const left =
					stuck.length === 0
						? ''
						: `; ${stuck.join(', ')} left on the new pair, the rollback failed`;
				return `${target.name}: ${this.#options.describe(error)}${left}`;
			}
		}
		return undefined;
	}
}

/** The TLS listeners that cannot take a renewed pair while running. */
export function heldOf(config: ServerConfig): string[] {
	const held =
		config.ports.https !== 0 &&
		config.jmap.mode === 'https' &&
		!config.jmap.reloadTls;
	return held ? ['https'] : [];
}

/** Watches the certificate files for a renewed pair, when `tls.mode` is `"files"`. */
export function watchCertificate(
	resources: Resources,
	started: readonly Listener[],
): TlsWatch | undefined {
	const { config, tls, log, describe } = resources;
	if (config.tls.mode !== 'files') return undefined;
	return watchTls({
		files: config.tls,
		hostname: config.hostname,
		applied: tls,
		targets: targetsOf(started),
		held: heldOf(config),
		log: (line) => log(line),
		describe,
	});
}
