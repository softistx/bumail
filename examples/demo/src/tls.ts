/**
 * The TLS certificate: the self-signed fixture `@bumail/smtp` and
 * `@bumail/imap` test with, for `localhost` and 127.0.0.1 only. A client
 * must be told to trust it. Never use it outside this demo.
 */
import { join } from 'node:path';

export interface Tls {
	readonly key: string;
	readonly cert: string;
}

const FIXTURES = join(
	import.meta.dir,
	'../../../packages/smtp/src/server/fixtures',
);

export async function fixtureTls(): Promise<Tls> {
	return {
		key: await Bun.file(join(FIXTURES, 'localhost.key')).text(),
		cert: await Bun.file(join(FIXTURES, 'localhost.crt')).text(),
	};
}
