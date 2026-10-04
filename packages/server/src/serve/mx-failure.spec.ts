import { afterEach, expect, test } from 'bun:test';
import { readdirSync } from 'node:fs';
import { fixtureResolver } from '@bumail/dns';
import type { SmtpServer } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { maskedFor } from '../store/open';
import { createMx } from './mx';
import { message, RECORDS, sendMail } from './serve.fixtures';
import { Spool } from './spool';

const URL_WITH_SECRET = 'postgres://bumail:store-secret-pw@db.internal/mail';

let server: SmtpServer | undefined;
let directory: Directory | undefined;

afterEach(() => {
	server?.stop(true);
	directory?.close();
	server = undefined;
	directory = undefined;
});

test('a store that fails answers 451, and its log line masks the store password', async () => {
	directory = await seededDirectory();
	const store = new MemoryMailStore();
	store.addMessage = () =>
		Promise.reject(
			new Error(`connection to ${URL_WITH_SECRET} refused (store-secret-pw)`),
		);
	const lines: string[] = [];
	const spool = Spool.open(tempDir(), 1 << 24);
	server = createMx({
		hostname: 'mail.example.com',
		directory,
		store,
		resolver: fixtureResolver(RECORDS),
		postmaster: undefined,
		inbound: {
			dmarc: 'enforce',
			maxMessageSize: 1 << 20,
			maxConnections: 10,
			maxConnectionsPerClient: 10,
			spoolBytes: 1 << 24,
		},
		tls: await selfSigned(['localhost']),
		spool,
		log: (line) => lines.push(line),
		describe: (error) =>
			maskedFor(
				error instanceof Error ? error.message : String(error),
				URL_WITH_SECRET,
			),
		onDelivered: () => {},
		track: (work) => work,
	});
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	const { last } = await sendMail(
		port,
		{ from: 'joe@pass.example', to: ['alice@example.com'] },
		message('joe@pass.example', 'store down'),
	);
	expect(last).toStartWith('451 ');
	const error = lines.find((line) => line.startsWith('mx: error in a session'));
	expect(error).toContain('connection to postgres://bumail:…@db.internal/mail');
	expect(lines.join('\n')).not.toContain('store-secret-pw');
	// Nothing is left in the spool, delivered or not.
	expect(readdirSync(spool.dir)).toEqual(['owner']);
	expect(spool.used).toBe(0);
});
