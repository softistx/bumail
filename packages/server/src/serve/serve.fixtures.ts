import { join } from 'node:path';
import { type FixtureRecords, fixtureResolver } from '@bumail/dns';
import { SqliteMailStore } from '@bumail/store/sqlite';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import { readConfig } from '../config/read';
import { Directory } from '../directory/directory';
import { PASSWORD } from '../directory/directory.fixtures';
import { type RunningServer, type ServeOptions, serve } from './serve';

export { LineClient, sendMail } from './line-client.fixtures';
export { PASSWORD };

/** The DNS the specs' senders have: SPF and DMARC records, a domain whose DNS is down. */
export const RECORDS: FixtureRecords = {
	'pass.example': { txt: ['v=spf1 ip4:127.0.0.1 ip6:::1 -all'] },
	'_dmarc.pass.example': { txt: ['v=DMARC1; p=reject'] },
	'reject.example': { txt: ['v=spf1 -all'] },
	'_dmarc.reject.example': { txt: ['v=DMARC1; p=reject'] },
	'quarantine.example': { txt: ['v=spf1 -all'] },
	'_dmarc.quarantine.example': { txt: ['v=DMARC1; p=quarantine'] },
	'_dmarc.down.example': { error: 'TEMPORARY' },
	'down.example': { error: 'TEMPORARY' },
};

export interface Fixture {
	readonly server: RunningServer;
	readonly dir: string;
	readonly lines: string[];
	/** The port a listener is bound to. */
	port(name: 'mx' | 'imaps' | 'imap'): number;
	stop(): Promise<void>;
}

/** The TOML of a server in `dir`: certificate files, a SQLite store and directory, `extra` after. */
export function configToml(dir: string, extra = ''): string {
	return [
		'hostname = "mail.example.com"',
		`data = "${dir}"`,
		'[store]',
		`url = "sqlite:${dir}/mail"`,
		'[directory]',
		`url = "sqlite:${dir}/directory.sqlite"`,
		'[tls]',
		'mode = "files"',
		'cert = "cert.pem"',
		'key = "key.pem"',
		extra,
	].join('\n');
}

/** A directory in `dir` hosting example.com, with alice and bob, and sales@ to both. */
export async function seed(dir: string): Promise<void> {
	const directory = Directory.open({ file: join(dir, 'directory.sqlite') });
	directory.domains.add('example.com');
	await directory.users.add('alice@example.com', PASSWORD);
	await directory.users.add('bob@example.com', PASSWORD);
	directory.aliases.add('sales@example.com', [
		'alice@example.com',
		'bob@example.com',
	]);
	directory.close();
}

/** Writes the certificate, the configuration and the directory into a fresh directory; answers it and the config file. */
export async function prepare(
	extra = '',
): Promise<{ dir: string; file: string }> {
	const dir = tempDir();
	const { cert, key } = await selfSigned(['mail.example.com', 'localhost']);
	await Bun.write(join(dir, 'cert.pem'), cert);
	await Bun.write(join(dir, 'key.pem'), key);
	const file = join(dir, 'bumail.toml');
	await Bun.write(file, configToml(dir, extra));
	await seed(dir);
	return { dir, file };
}

/** The server for `extra` (TOML after the base), on free ports, on the fixture DNS. */
export async function startServer(
	extra = '',
	options: ServeOptions = {},
): Promise<Fixture> {
	const { dir, file } = await prepare(extra);
	const config = await readConfig({ path: file, env: {} });
	const lines: string[] = [];
	const server = await serve(config, {
		log: (line) => lines.push(line),
		resolver: fixtureResolver(RECORDS),
		port: () => 0,
		...options,
	});
	return {
		server,
		dir,
		lines,
		port(name) {
			const found = server.listening.find((l) => l.name === name);
			if (found === undefined) throw new Error(`${name} is not listening`);
			return found.port;
		},
		stop: () => server.stop(),
	};
}

/** The messages in `address`'s mailbox of `role`, as text, from the store in `dir` (the server stopped). */
export async function mailOf(
	dir: string,
	address: string,
	role: 'inbox' | 'junk',
): Promise<string[]> {
	const store = SqliteMailStore.open({ directory: join(dir, 'mail') });
	try {
		const account = await store.findAccount(address);
		if (account === undefined) return [];
		const mailbox = await store.findMailbox(account.id, role);
		if (mailbox === undefined) return [];
		const texts: string[] = [];
		for (const { message } of await store.listMessages(
			account.id,
			mailbox.id,
		)) {
			const blob = await store.readContent(account.id, message.blobId);
			texts.push((await blob?.text()) ?? '');
		}
		return texts;
	} finally {
		store.close();
	}
}

/** A message `From:` `from`, with `headers` above its own. */
export function message(from: string, subject: string, headers = ''): string {
	return `${headers}From: <${from}>\r\nTo: <alice@example.com>\r\nSubject: ${subject}\r\nMessage-ID: <${crypto.randomUUID()}@client.example>\r\n\r\nHello.\r\n`;
}
