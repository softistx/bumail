/**
 * Wires the packages together: one sqlite store, an MX, a submission
 * server and IMAP on two ports, all serving alice@example.test.
 */
import { rmSync } from 'node:fs';
import {
	createImapServer,
	type ImapServer,
	type ImapServerOptions,
} from '@bumail/imap';
import type { SmtpServer } from '@bumail/smtp';
import { SqliteMailStore } from '@bumail/store/sqlite';
import {
	ADDRESS,
	type DemoConfig,
	DKIM_SELECTOR,
	DOMAIN,
	HOSTNAME,
} from './config';
import { demoResolver, dkimRecord } from './dns';
import { createMx } from './inbound';
import { openMailboxes } from './mailboxes';
import { createSubmission } from './submission';
import { fixtureTls } from './tls';

/** What the demo prints once it listens, and what the e2e reads. */
export interface DemoInfo {
	readonly address: string;
	readonly password: string;
	readonly directory: string;
	readonly temporary: boolean;
	readonly ports: DemoConfig['ports'];
	readonly smarthost: DemoConfig['smarthost'];
	/** The TXT record of the key the submission server signs with. */
	readonly dkim: { readonly name: string; readonly record: string };
}

export interface Demo {
	readonly info: DemoInfo;
	stop(): Promise<void>;
}

export async function startDemo(
	config: DemoConfig,
	log: (line: string) => void = console.log,
): Promise<Demo> {
	const store = SqliteMailStore.open({ directory: config.directory });
	const mailboxes = await openMailboxes(store, config.password);
	const tls = await fixtureTls();

	const keys = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const publicKey = new Uint8Array(
		await crypto.subtle.exportKey('raw', keys.publicKey),
	).toBase64();
	const resolver = demoResolver(publicKey);

	const imapOptions: ImapServerOptions = {
		hostname: HOSTNAME,
		store,
		tls,
		authenticate: async ({ username, password }) =>
			(await mailboxes.login(username, password)) ?? null,
		onError: (error) => log(`imap error ${error}`),
	};
	const imap: ImapServer[] = [
		createImapServer(imapOptions),
		createImapServer({ ...imapOptions, implicitTls: true }),
	];
	mailboxes.onDelivered((accountId) => {
		for (const server of imap) server.notify(accountId);
	});

	const smtp: SmtpServer[] = [
		createMx(mailboxes, resolver, tls, log),
		createSubmission({
			mailboxes,
			tls,
			dkimKey: keys.privateKey,
			smarthost: config.smarthost,
			log,
		}),
	];

	const hostname = config.bind;
	try {
		await smtp[0]?.listen({ port: config.ports.mx, hostname });
		await smtp[1]?.listen({ port: config.ports.submission, hostname });
		await imap[0]?.listen({ port: config.ports.imap, hostname });
		await imap[1]?.listen({ port: config.ports.imaps, hostname });
	} catch (error) {
		for (const server of [...smtp, ...imap]) server.stop(true);
		store.close();
		throw error;
	}

	return {
		info: {
			address: ADDRESS,
			password: config.password,
			directory: config.directory,
			temporary: config.temporary,
			ports: config.ports,
			smarthost: config.smarthost,
			dkim: {
				name: `${DKIM_SELECTOR}._domainkey.${DOMAIN}`,
				record: dkimRecord(publicKey),
			},
		},
		async stop() {
			for (const server of [...smtp, ...imap]) server.stop(true);
			store.close();
			if (config.temporary) {
				rmSync(config.directory, { recursive: true, force: true });
			}
		},
	};
}
