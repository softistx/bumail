import type { ServerConfig } from '../config/types';
import { type RunningServer, serve } from '../serve/serve';
import type { Io } from './run';

/**
 * `bumail serve`: runs the server until SIGTERM or SIGINT, then stops it
 * cleanly and answers 0. A second signal while it drains stops it at
 * once. SIGHUP looks for a renewed certificate (`reloadTls`). The log goes
 * to standard output.
 */
export async function serveUntilSignal(
	config: ServerConfig,
	io: Io,
): Promise<number> {
	const log = (line: string) => io.out(`${line}\n`);
	// A signal while `serve` still waits for a first certificate (`tls.mode
	// = "acme"`) aborts the wait, which stops what had started.
	const waiting = new AbortController();
	let first: string | undefined;
	let unsubscribe = () => {};
	let drain: (name: string) => void = (name) => {
		first ??= name;
		waiting.abort();
	};
	unsubscribe = io.signals?.((name) => drain(name)) ?? unsubscribe;
	// A SIGHUP while `serve` waits for a first certificate has nothing to
	// reload: it says so and the wait goes on.
	let server: RunningServer | undefined;
	const unreload =
		io.reloads?.(() => {
			if (server === undefined) {
				log(
					'bumail: SIGHUP, the server has not started yet; nothing to reload',
				);
				return;
			}
			log('bumail: SIGHUP, looking for a renewed certificate');
			void server.reloadTls();
		}) ?? (() => {});
	try {
		server = await serve(config, { log, signal: waiting.signal });
	} catch (error) {
		unsubscribe();
		unreload();
		if (first === undefined) throw error;
		log(`bumail: ${first}, stopping`);
		return 0;
	}
	if (io.signals === undefined) {
		unreload();
		await server.stop();
		return 0;
	}
	const signal = await new Promise<string>((resolve) => {
		const again = (name: string) => {
			if (first === undefined) {
				first = name;
				resolve(name);
			} else {
				log(`bumail: ${name} again, stopping now`);
				void server.stop({ force: true });
			}
		};
		// A signal that came during the start counts as the first.
		if (first !== undefined) resolve(first);
		drain = again;
	});
	log(`bumail: ${signal}, stopping`);
	unreload();
	await server.stop();
	unsubscribe();
	return 0;
}
