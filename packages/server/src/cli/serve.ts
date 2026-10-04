import type { ServerConfig } from '../config/types';
import { serve } from '../serve/serve';
import type { Io } from './run';

/**
 * `bumail serve`: runs the server until SIGTERM or SIGINT, then stops it
 * cleanly and answers 0. A second signal while it drains stops it at
 * once. The log goes to standard output.
 */
export async function serveUntilSignal(
	config: ServerConfig,
	io: Io,
): Promise<number> {
	const log = (line: string) => io.out(`${line}\n`);
	const server = await serve(config, { log });
	if (io.signals === undefined) {
		await server.stop();
		return 0;
	}
	let unsubscribe = () => {};
	const signal = await new Promise<string>((resolve) => {
		let first: string | undefined;
		unsubscribe =
			io.signals?.((name) => {
				if (first === undefined) {
					first = name;
					resolve(name);
				} else {
					log(`bumail: ${name} again, stopping now`);
					void server.stop({ force: true });
				}
			}) ?? unsubscribe;
	});
	log(`bumail: ${signal}, stopping`);
	await server.stop();
	unsubscribe();
	return 0;
}
