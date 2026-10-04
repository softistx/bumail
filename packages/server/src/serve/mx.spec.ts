import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { importDkimPrivateKey, signDkim } from '@bumail/auth';
import { fixtureResolver } from '@bumail/dns';
import { Directory } from '../directory/directory';
import {
	type Fixture,
	LineClient,
	mailOf,
	message,
	RECORDS,
	sendMail,
	startServer,
} from './serve.fixtures';

let fixture: Fixture | undefined;

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

async function start(extra = ''): Promise<Fixture> {
	fixture = await startServer(extra);
	return fixture;
}

/** Stops the server, so its SQLite store can be read. */
async function stopped(f: Fixture): Promise<string> {
	await f.stop();
	fixture = undefined;
	return f.dir;
}

describe('mx: delivery', () => {
	test('delivers to a user, with Return-Path and Received on top', async () => {
		const f = await start();
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'to a user'),
		);
		expect(last).toStartWith('250 ');
		const [mail] = await mailOf(await stopped(f), 'alice@example.com', 'inbox');
		expect(mail).toStartWith('Return-Path: <joe@pass.example>\r\n');
		const lines = (mail ?? '').split('\r\n');
		expect(lines[1]).toStartWith('Authentication-Results: mail.example.com;');
		expect(mail).toMatch(
			/\r\nReceived: from client\.example \(\[[^\]]+\]\)\r\n\tby mail\.example\.com with ESMTP id /,
		);
		expect(mail).toContain('spf=pass');
		expect(mail).toContain('dmarc=pass');
		expect(mail).toContain('Subject: to a user\r\n');
	});

	test('delivers to an alias once to each of its users, and once to a user also named', async () => {
		const f = await start();
		const { last } = await sendMail(
			f.port('mx'),
			{
				from: 'joe@pass.example',
				to: ['sales@example.com', 'Alice@Example.com'],
			},
			message('joe@pass.example', 'to an alias'),
		);
		expect(last).toStartWith('250 ');
		const dir = await stopped(f);
		expect(await mailOf(dir, 'alice@example.com', 'inbox')).toHaveLength(1);
		expect(await mailOf(dir, 'bob@example.com', 'inbox')).toHaveLength(1);
	});

	test('creates the account and its mailboxes when the store has none', async () => {
		const f = await start();
		// The directory was seeded without the store: nobody has an account yet.
		expect(
			(
				await sendMail(
					f.port('mx'),
					{ from: '', to: ['bob@example.com'] },
					message('mailer-daemon@pass.example', 'a bounce'),
					// A bounce's SPF is its HELO name's.
					{ helo: 'pass.example' },
				)
			).last,
		).toStartWith('250 ');
		const [mail] = await mailOf(await stopped(f), 'bob@example.com', 'inbox');
		expect(mail).toStartWith('Return-Path: <>\r\n');
	});

	test('takes STARTTLS, and delivers over it', async () => {
		const f = await start();
		const { replies, last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'over TLS'),
			{ starttls: true },
		);
		expect(replies[1]).toContain('STARTTLS');
		expect(replies[2]).toStartWith('220 ');
		expect(last).toStartWith('250 ');
		const [mail] = await mailOf(await stopped(f), 'alice@example.com', 'inbox');
		expect(mail).toContain('with ESMTPS id');
	});

	test('refuses a message over inbound.maxMessageSize', async () => {
		const f = await start('[inbound]\nmaxMessageSize = 2000');
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'too big').replace(
				'Hello.',
				'x'.repeat(4000),
			),
		);
		expect(last).toStartWith('552 ');
		expect(
			await mailOf(await stopped(f), 'alice@example.com', 'inbox'),
		).toEqual([]);
	});

	test('takes no more than inbound.maxConnections at once', async () => {
		const f = await start('[inbound]\nmaxConnections = 1');
		const first = await LineClient.connect(f.port('mx'));
		expect(await first.reply()).toStartWith('220 ');
		const second = await LineClient.connect(f.port('mx'));
		expect(await second.reply()).toStartWith('421 ');
		first.end();
	});
});

describe('mx: never an open relay', () => {
	test('offers no AUTH, before or after STARTTLS, and refuses the command', async () => {
		const f = await start();
		const client = await LineClient.connect(f.port('mx'));
		await client.reply();
		expect(await client.smtp('EHLO client.example')).not.toContain('AUTH');
		expect(await client.smtp('STARTTLS')).toStartWith('220 ');
		await client.startTls();
		const ehlo = await client.smtp('EHLO client.example');
		expect(ehlo).toStartWith('250-');
		expect(ehlo).not.toContain('AUTH');
		expect(await client.smtp('AUTH PLAIN AGFsaWNlAHg=')).toMatch(/^5\d\d /);
		client.end();
	});

	test('refuses a recipient in another domain, whoever the sender', async () => {
		const f = await start();
		for (const from of ['joe@pass.example', 'alice@example.com', '']) {
			const { replies } = await sendMail(
				f.port('mx'),
				{ from, to: ['victim@elsewhere.example'] },
				message('joe@pass.example', 'relay'),
			);
			expect(replies.at(-1)).toStartWith('554 5.7.1 Relay access denied');
		}
	});

	test('refuses a foreign recipient after STARTTLS too: TLS is no authentication', async () => {
		const f = await start();
		const { replies } = await sendMail(
			f.port('mx'),
			{ from: 'alice@example.com', to: ['victim@elsewhere.example'] },
			message('alice@example.com', 'relay'),
			{ starttls: true },
		);
		expect(replies.at(-1)).toStartWith('554 5.7.1');
	});

	test('refuses an unknown user of a hosted domain with 550 user unknown', async () => {
		const f = await start();
		const client = await LineClient.connect(f.port('mx'));
		await client.reply();
		await client.smtp('EHLO client.example');
		await client.smtp('MAIL FROM:<joe@pass.example>');
		expect(await client.smtp('RCPT TO:<nobody@example.com>')).toStartWith(
			'550 5.1.1 User unknown',
		);
		expect(await client.smtp('RCPT TO:<alice@example.com>')).toStartWith('250');
		client.end();
	});
});

describe('mx: DMARC', () => {
	test('enforce: p=reject is refused with 550 during DATA, and nothing is kept', async () => {
		const f = await start();
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@reject.example', to: ['alice@example.com'] },
			message('joe@reject.example', 'forged'),
		);
		expect(last).toStartWith(
			'550 5.7.1 Rejected by the DMARC policy of reject.example',
		);
		expect(f.lines.some((l) => l.includes('refused by DMARC'))).toBe(true);
		expect(
			await mailOf(await stopped(f), 'alice@example.com', 'inbox'),
		).toEqual([]);
	});

	test('enforce: p=quarantine goes to Junk', async () => {
		const f = await start();
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@quarantine.example', to: ['alice@example.com'] },
			message('joe@quarantine.example', 'suspect'),
		);
		expect(last).toStartWith('250 ');
		const dir = await stopped(f);
		expect(await mailOf(dir, 'alice@example.com', 'inbox')).toEqual([]);
		const [junk] = await mailOf(dir, 'alice@example.com', 'junk');
		expect(junk).toContain('dmarc=fail');
	});

	test('enforce: a DMARC lookup that fails for now is deferred with 451', async () => {
		const f = await start();
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@down.example', to: ['alice@example.com'] },
			message('joe@down.example', 'later'),
		);
		expect(last).toStartWith('451 4.7.0');
	});

	test('mark: p=reject and p=quarantine are delivered to INBOX, and recorded', async () => {
		const f = await start('[inbound]\ndmarc = "mark"');
		for (const domain of ['reject.example', 'quarantine.example']) {
			const { last } = await sendMail(
				f.port('mx'),
				{ from: `joe@${domain}`, to: ['alice@example.com'] },
				message(`joe@${domain}`, domain),
			);
			expect(last).toStartWith('250 ');
		}
		const inbox = await mailOf(await stopped(f), 'alice@example.com', 'inbox');
		expect(inbox).toHaveLength(2);
		for (const mail of inbox) expect(mail).toContain('dmarc=fail');
	});
});

describe('mx: Authentication-Results', () => {
	test("strips a field claiming the server's name, and any Return-Path, keeping the rest", async () => {
		const f = await start();
		const forged = [
			'Authentication-Results: mail.example.com; dmarc=pass header.from=bank.example',
			'Authentication-Results: (a comment)\r\n MAIL.EXAMPLE.COM.; spf=pass',
			'Authentication-Results: "mail.example.com"; dkim=pass',
			'Authentication-Results: relay.other.example; spf=pass smtp.mailfrom=x.example',
			'Return-Path: <forged@bank.example>',
			'',
		].join('\r\n');
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'forged results', forged),
		);
		expect(last).toStartWith('250 ');
		const [mail = ''] = await mailOf(
			await stopped(f),
			'alice@example.com',
			'inbox',
		);
		const fields = mail.slice(0, mail.indexOf('\r\n\r\n'));
		expect(fields.match(/^Authentication-Results:/gim)).toHaveLength(2);
		expect(fields).toContain(
			'Authentication-Results: relay.other.example; spf=pass smtp.mailfrom=x.example',
		);
		expect(fields).not.toContain('bank.example');
		expect(fields).not.toContain('a comment');
		expect(fields.match(/^Return-Path:/gim)).toHaveLength(1);
		expect(fields).toStartWith('Return-Path: <joe@pass.example>\r\n');
	});
});

describe('mx: refusals during DATA', () => {
	test('a header over 256 KiB is refused with 552', async () => {
		const f = await start();
		const long = `X-Filler: ${'a'.repeat(900)}\r\n`.repeat(300);
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['alice@example.com'] },
			message('joe@pass.example', 'long header', long),
		);
		expect(last).toStartWith('552 5.3.4 Message header too large');
	});

	test('enforce: a message with no From, or two, is refused as DMARC cannot read it', async () => {
		const f = await start();
		const noFrom = 'To: <alice@example.com>\r\nSubject: none\r\n\r\nHi.\r\n';
		const twoFrom = message(
			'joe@pass.example',
			'two authors',
			'From: <ceo@bank.example>\r\n',
		);
		for (const text of [noFrom, twoFrom]) {
			const { last } = await sendMail(
				f.port('mx'),
				{ from: 'joe@pass.example', to: ['alice@example.com'] },
				text,
			);
			expect(last).toStartWith(
				'550 5.7.1 The From field cannot be evaluated for DMARC',
			);
		}
	});

	test('an alias removed between RCPT and the end of DATA leaves no recipient', async () => {
		const f = await start();
		const client = await LineClient.connect(f.port('mx'));
		await client.reply();
		await client.smtp('EHLO client.example');
		await client.smtp('MAIL FROM:<joe@pass.example>');
		expect(await client.smtp('RCPT TO:<sales@example.com>')).toStartWith('250');
		const directory = Directory.open({ file: join(f.dir, 'directory.sqlite') });
		directory.aliases.remove('sales@example.com');
		directory.close();
		await client.smtp('DATA');
		const body = message('joe@pass.example', 'gone');
		expect(await client.smtp(`${body}\r\n.`)).toStartWith(
			'550 5.1.1 No recipient of this message is here any longer',
		);
		client.end();
	});
});

describe('mx: DKIM', () => {
	test('a signature aligned with From passes DMARC even when SPF fails', async () => {
		const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
			'sign',
			'verify',
		])) as CryptoKeyPair;
		const raw = new Uint8Array(
			await crypto.subtle.exportKey('raw', pair.publicKey),
		);
		const pkcs8 = Buffer.from(
			await crypto.subtle.exportKey('pkcs8', pair.privateKey),
		).toString('base64');
		const pem = `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`;
		const privateKey = await importDkimPrivateKey(pem);
		fixture = await startServer('', {
			resolver: fixtureResolver({
				...RECORDS,
				'sel._domainkey.reject.example': {
					txt: [`v=DKIM1; k=ed25519; p=${Buffer.from(raw).toString('base64')}`],
				},
			}),
		});
		const f = fixture;
		const text = message('joe@reject.example', 'signed');
		const signature = await signDkim(text, {
			domain: 'reject.example',
			selector: 'sel',
			privateKey,
		});
		const { last } = await sendMail(
			f.port('mx'),
			{ from: 'joe@reject.example', to: ['alice@example.com'] },
			signature + text,
		);
		expect(last).toStartWith('250 ');
		const [mail = ''] = await mailOf(
			await stopped(f),
			'alice@example.com',
			'inbox',
		);
		expect(mail).toContain('dkim=pass');
		expect(mail).toContain('dmarc=pass');
		expect(mail).toContain('spf=fail');
	});
});
