import { readConfig } from '../config/read';
import { ServerError } from '../errors';
import type { HealthArgs } from './init/args';
import type { Io } from './run';

/** How long the health check may take to answer, in milliseconds. */
const WAIT_MS = 5000;

/** The loopback address the health check listens on, given its `bind`. */
function target(bind: string): string {
	if (bind === '0.0.0.0') return '127.0.0.1';
	if (bind === '::') return '[::1]';
	return bind.includes(':') ? `[${bind}]` : bind;
}

/**
 * Whether a 503 is only a server waiting for its certificate: the TLS
 * listeners cannot start without one, so everything but the challenge
 * listener (`http`) is down, but that one answers, and so do the
 * directory and the store.
 */
function waitingForCertificate(status: number, body: string): boolean {
	if (status !== 503) return false;
	try {
		const report = JSON.parse(body) as {
			tls?: unknown;
			directory?: unknown;
			store?: unknown;
			listeners?: Record<string, unknown>;
		};
		return (
			report.tls === 'down' &&
			report.directory === 'ok' &&
			report.store === 'ok' &&
			report.listeners?.['http'] === 'up'
		);
	} catch {
		return false;
	}
}

/**
 * `bumail health`: asks `GET /healthz` of the server this configuration
 * runs, on `ports.health` at `health.bind`, and answers whether it said
 * 200 — for a Docker `HEALTHCHECK`, where the image has no curl. Prints
 * `ok` or why not, never more than the check's own body. With
 * `--tls-pending`, a server that is waiting for its first certificate (or
 * past the end of its last) counts as well, since it answers the CA's
 * challenge: a proxy that routes only to healthy containers needs that.
 */
export async function health(args: HealthArgs, io: Io): Promise<boolean> {
	const config = await readConfig({
		...(args.config === undefined ? {} : { path: args.config }),
		env: io.env,
	});
	if (config.ports.health === 0) {
		throw new ServerError(
			'UNAVAILABLE',
			'the health check is turned off (ports.health = 0)',
		);
	}
	const url = `http://${target(config.health.bind)}:${config.ports.health}/healthz`;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(WAIT_MS) });
		const body = (await response.text()).slice(0, 500);
		if (response.ok) {
			io.out('ok\n');
			return true;
		}
		if (args.tlsPending && waitingForCertificate(response.status, body)) {
			io.out('ok (waiting for a certificate)\n');
			return true;
		}
		io.err(`bumail: unhealthy: ${response.status} ${body}\n`);
	} catch {
		io.err(
			`bumail: unhealthy: ${url} did not answer; is bumail serve running?\n`,
		);
	}
	return false;
}
