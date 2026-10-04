import { afterEach, expect, test } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { importDkimPrivateKey, signDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';
import type { SmtpServer } from '@bumail/smtp';
import { MemoryMailStore } from '@bumail/store';
import { selfSigned } from '../config/certificates.fixtures';
import { tempDir } from '../config/config.fixtures';
import type { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { createMx } from './mx';
import { message, RECORDS, sendMail } from './serve.fixtures';
import { Spool } from './spool';

let server: SmtpServer | undefined;
let directory: Directory | undefined;
let spool: Spool | undefined;

afterEach(() => {
	server?.stop(true);
	directory?.close();
	spool?.close();
	server = undefined;
	directory = undefined;
	spool = undefined;
});

/** An Ed25519 DKIM key: its private key, and its DNS record. */
async function dkimKey() {
	const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
		'sign',
		'verify',
	])) as CryptoKeyPair;
	const raw = Buffer.from(await crypto.subtle.exportKey('raw', pair.publicKey));
	const pkcs8 = Buffer.from(
		await crypto.subtle.exportKey('pkcs8', pair.privateKey),
	).toString('base64');
	const privateKey = await importDkimPrivateKey(
		`-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
	);
	return {
		privateKey,
		record: `v=DKIM1; k=ed25519; p=${raw.toString('base64')}`,
	};
}

/** The messages in `address`'s INBOX, as text. */
async function inboxOf(
	store: MemoryMailStore,
	address: string,
): Promise<string[]> {
	const account = await store.findAccount(address);
	if (account === undefined) return [];
	const inbox = await store.findMailbox(account.id, 'inbox');
	if (inbox === undefined) return [];
	const texts: string[] = [];
	for (const { message } of await store.listMessages(account.id, inbox.id)) {
		const blob = await store.readContent(account.id, message.blobId);
		texts.push((await blob?.text()) ?? '');
	}
	return texts;
}

test('a message already spooled is checked and delivered, once to each user, after its folder is swept', async () => {
	directory = await seededDirectory();
	const store = new MemoryMailStore();
	const lines: string[] = [];
	const opened = Spool.open(tempDir(), 1 << 24);
	spool = opened;
	// Another server sweeps the folder right after the message is written.
	const write = opened.write.bind(opened);
	opened.write = async (id, content) => {
		const spooled = await write(id, content);
		rmSync(opened.dir, { recursive: true, force: true });
		return spooled;
	};
	const { privateKey, record } = await dkimKey();
	server = createMx({
		hostname: 'mail.example.com',
		directory,
		store,
		resolver: fixtureResolver({
			...RECORDS,
			'sel._domainkey.reject.example': { txt: [record] },
		}),
		inbound: {
			dmarc: 'enforce',
			maxMessageSize: 1 << 20,
			maxConnections: 10,
			spoolBytes: 1 << 24,
		},
		tls: await selfSigned(['localhost']),
		spool: opened,
		log: (line) => lines.push(line),
		describe: (error) =>
			error instanceof Error ? error.message : String(error),
		onDelivered: () => {},
		track: (work) => work,
	});
	const { port } = await server.listen({ port: 0, hostname: '127.0.0.1' });
	// SPF fails for reject.example, whose DMARC says p=reject: only DKIM,
	// which reads the whole spooled message, lets it in.
	const text = message('joe@reject.example', 'swept');
	const signature = await signDkim(text, {
		domain: 'reject.example',
		selector: 'sel',
		privateKey,
	});
	const { last } = await sendMail(
		port,
		{ from: 'joe@reject.example', to: ['sales@example.com'] },
		signature + text,
	);
	expect(last).toStartWith('250 ');
	expect(existsSync(opened.dir)).toBe(false);
	for (const user of ['alice@example.com', 'bob@example.com']) {
		const mails = await inboxOf(store, user);
		expect(mails).toHaveLength(1);
		expect(mails[0]).toContain('dkim=pass');
		expect(mails[0]).toContain('dmarc=pass');
		expect(mails[0]).toContain(`${signature}${text}`);
	}
	expect(opened.used).toBe(0);
});
