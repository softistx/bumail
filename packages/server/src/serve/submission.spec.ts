import { afterEach, describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { Directory } from '../directory/directory';
import { seededDirectory } from '../directory/directory.fixtures';
import { LineClient } from './line-client.fixtures';
import { type Fixture, mailOf, startServer } from './serve.fixtures';
import { checkRecipient } from './submission';
import { letter, plain, session, submit } from './submission.fixtures';

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

describe('submission: AUTH', () => {
	test('587 offers no AUTH in clear, refuses it, and refuses MAIL unauthenticated', async () => {
		const f = await start();
		const client = await LineClient.connect(f.port('submission'));
		expect(await client.reply()).toStartWith('220 ');
		const ehlo = await client.smtp('EHLO client.example');
		expect(ehlo).toContain('STARTTLS');
		expect(ehlo).not.toContain('AUTH');
		expect(await client.smtp(plain('alice@example.com'))).toStartWith('538 ');
		expect(await client.smtp('MAIL FROM:<alice@example.com>')).toStartWith(
			'530 ',
		);
		client.end();
	});

	test('465 refuses MAIL before AUTH, with 530', async () => {
		const f = await start();
		const client = await session(f.port('submissions'), true);
		expect(await client.smtp('MAIL FROM:<alice@example.com>')).toStartWith(
			'530 ',
		);
		client.end();
	});

	test('587 offers AUTH after STARTTLS, and 465 at once', async () => {
		const f = await start();
		for (const [name, implicit] of [
			['submission', false],
			['submissions', true],
		] as const) {
			const client = await LineClient.connect(f.port(name), implicit);
			await client.reply();
			if (!implicit) {
				await client.smtp('EHLO client.example');
				await client.smtp('STARTTLS');
				await client.startTls();
			}
			expect(await client.smtp('EHLO client.example')).toMatch(
				/AUTH PLAIN LOGIN/,
			);
			expect(await client.smtp(plain('Alice@Example.COM'))).toStartWith('235 ');
			client.end();
		}
	});

	test('a wrong password is refused with 535, and logged', async () => {
		const f = await start();
		const client = await session(f.port('submissions'), true);
		expect(
			await client.smtp(plain('alice@example.com', 'not the password')),
		).toStartWith('535 ');
		client.end();
		expect(f.lines).toContain(
			'submissions: login refused from 127.0.0.1: password',
		);
	});

	test('the limiter blocks a client after 10 failures, its right password included', async () => {
		const f = await start();
		// smtp hangs up after 3 failed attempts: 4 sessions make 12.
		for (let i = 0; i < 4; i++) {
			const client = await session(f.port('submissions'), true);
			for (let j = 0; j < 3; j++) {
				await client.smtp(plain('alice@example.com', `wrong ${i} ${j}`));
			}
			client.end();
		}
		const client = await session(f.port('submissions'), true);
		expect(await client.smtp(plain('alice@example.com'))).toStartWith('535 ');
		client.end();
		expect(f.lines).toContain(
			'submissions: login refused from 127.0.0.1: blocked',
		);
	}, 30_000);
});

describe('submission: the sender', () => {
	test('refuses a MAIL FROM that is not the user, with 553', async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'alice@example.com',
		);
		for (const from of ['bob@example.com', 'ceo@bank.example', '']) {
			expect(await client.smtp(`MAIL FROM:<${from}>`)).toStartWith(
				`553 5.7.1 Not authorized to send as <${from}>`,
			);
		}
		client.end();
		expect(f.lines).toContain(
			'submissions: alice@example.com from 127.0.0.1 refused as sender <bob@example.com>',
		);
	});

	test('takes the user in any case, and an alias it belongs to', async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'Alice@Example.COM',
		);
		for (const from of ['ALICE@example.com', 'sales@example.com']) {
			expect(await client.smtp(`MAIL FROM:<${from}>`)).toStartWith('250');
			await client.smtp('RSET');
		}
		client.end();
	});

	test('refuses a From field naming another address, with 550', async () => {
		const f = await start();
		const client = await session(
			f.port('submission'),
			false,
			'alice@example.com',
		);
		const forged = [
			letter('bob@example.com', 'bob@example.com', 'as bob'),
			letter('alice@example.com', 'bob@example.com', 'x').replace(
				'From: Someone <alice@example.com>',
				'From: "bob@example.com" <alice@example.com>',
			),
			letter('alice@example.com', 'bob@example.com', 'x').replace(
				'From: Someone <alice@example.com>',
				'From: <"bob"@example.com>',
			),
		];
		for (const text of forged) {
			const { last } = await submit(
				client,
				'alice@example.com',
				['bob@example.com'],
				text,
			);
			expect(last).toStartWith(
				'550 5.7.1 The From field names an address that is not yours',
			);
		}
		const ok = (from: string) =>
			letter('alice@example.com', 'bob@example.com', 'x').replace(
				'From: Someone <alice@example.com>',
				`From: ${from}`,
			);
		// An encoded-word display name is held to the rule decoded, as a reader sees it.
		for (const from of [
			'=?UTF-8?Q?ceo=40bank=2Eexample?= <alice@example.com>',
			'=?UTF-8?B?Y2VvQGJhbmsuZXhhbXBsZQ==?= <alice@example.com>',
			'Alice <alice@example.com> (bob@example.com)',
		]) {
			const { last } = await submit(
				client,
				'alice@example.com',
				['bob@example.com'],
				ok(from),
			);
			expect(last).toStartWith('550 5.7.1');
		}
		const none = await submit(
			client,
			'alice@example.com',
			['bob@example.com'],
			ok('undisclosed:;'),
		);
		expect(none.last).toStartWith(
			'550 5.6.0 The From field must name your address',
		);
		const twice = `From: <alice@example.com>\r\n${letter('alice@example.com', 'bob@example.com', 'two')}`;
		expect(
			(await submit(client, 'alice@example.com', ['bob@example.com'], twice))
				.last,
		).toStartWith('550 5.6.0 The message needs exactly one From field');
		client.end();
		expect(f.lines).toContainEqual(
			expect.stringMatching(/refused: its From field names no address$/),
		);
		expect(await mailOf(await stopped(f), 'bob@example.com', 'inbox')).toEqual(
			[],
		);
	});

	test('takes an encoded-word display name and a comment that hold no address', async () => {
		const f = await start();
		const client = await session(
			f.port('submission'),
			false,
			'alice@example.com',
		);
		for (const from of [
			'=?UTF-8?Q?Alice_M=C3=BCller?= <alice@example.com>',
			'alice@example.com (Alice, at work)',
			'Alice <alice@example.com>, (also) sales@example.com',
		]) {
			const text = letter('alice@example.com', 'bob@example.com', 'x').replace(
				'From: Someone <alice@example.com>',
				`From: ${from}`,
			);
			const { last } = await submit(
				client,
				'alice@example.com',
				['bob@example.com'],
				text,
			);
			expect(last).toStartWith('250 ');
		}
		client.end();
	});
});

describe('submission: local delivery', () => {
	test('delivers to a local user and an alias straight to the store, queueing nothing', async () => {
		const f = await start();
		const client = await session(
			f.port('submission'),
			false,
			'alice@example.com',
		);
		const { last } = await submit(
			client,
			'sales@example.com',
			['bob@example.com', 'sales@example.com'],
			letter('sales@example.com', 'bob@example.com', 'local'),
		);
		expect(last).toStartWith('250 ');
		await client.smtp('QUIT');
		client.end();
		expect(
			f.lines.some((l) =>
				/^submission: \S+ from alice@example\.com <sales@example\.com> delivered to bob@example\.com, alice@example\.com \(unsigned\)$/.test(
					l,
				),
			),
		).toBe(true);
		const dir = await stopped(f);
		const [mail = ''] = await mailOf(dir, 'bob@example.com', 'inbox');
		expect(mail).toStartWith('Return-Path: <sales@example.com>\r\n');
		expect(mail).toContain('Subject: local\r\n');
		expect(await mailOf(dir, 'alice@example.com', 'inbox')).toHaveLength(1);
	});

	test('refuses an unknown user of a hosted domain at RCPT', async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'alice@example.com',
		);
		await client.smtp('MAIL FROM:<alice@example.com>');
		expect(await client.smtp('RCPT TO:<nobody@example.com>')).toStartWith(
			'550 5.1.1 User unknown',
		);
		client.end();
	});

	test("strips an Authentication-Results claiming the server's name", async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'alice@example.com',
		);
		const text = `Authentication-Results: mail.example.com; dmarc=pass\r\n${letter('alice@example.com', 'bob@example.com', 'forged')}`;
		expect(
			(await submit(client, 'alice@example.com', ['bob@example.com'], text))
				.last,
		).toStartWith('250 ');
		client.end();
		const [mail = ''] = await mailOf(
			await stopped(f),
			'bob@example.com',
			'inbox',
		);
		expect(mail).not.toContain('Authentication-Results');
	});

	test('a user removed after its login can send no more', async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'bob@example.com',
		);
		const directory = Directory.open({ file: join(f.dir, 'directory.sqlite') });
		directory.aliases.remove('sales@example.com');
		directory.users.remove('bob@example.com');
		directory.close();
		expect(await client.smtp('MAIL FROM:<bob@example.com>')).toStartWith(
			'553 5.7.1',
		);
		client.end();
	});

	test('a user disabled, or given a new password, after its login can send no more', async () => {
		const f = await start();
		const alice = await session(
			f.port('submissions'),
			true,
			'alice@example.com',
		);
		const bob = await session(f.port('submissions'), true, 'bob@example.com');
		expect(await alice.smtp('MAIL FROM:<alice@example.com>')).toStartWith(
			'250',
		);
		await alice.smtp('RSET');
		const directory = Directory.open({ file: join(f.dir, 'directory.sqlite') });
		directory.users.setDisabled('alice@example.com', true);
		await directory.users.setPassword(
			'bob@example.com',
			'a brand new passphrase',
		);
		directory.close();
		expect(await alice.smtp('MAIL FROM:<alice@example.com>')).toStartWith(
			'553 5.7.1',
		);
		expect(await bob.smtp('MAIL FROM:<bob@example.com>')).toStartWith(
			'553 5.7.1',
		);
		alice.end();
		bob.end();
	});

	test('<postmaster> goes to the postmaster configured', async () => {
		const f = await start('postmaster = "alice@example.com"');
		const client = await session(
			f.port('submissions'),
			true,
			'bob@example.com',
		);
		const { last } = await submit(
			client,
			'bob@example.com',
			['postmaster'],
			letter('bob@example.com', 'postmaster', 'to the postmaster'),
		);
		expect(last).toStartWith('250 ');
		client.end();
		expect(
			await mailOf(await stopped(f), 'alice@example.com', 'inbox'),
		).toHaveLength(1);
	});

	test('<postmaster> is refused while nothing answers it', async () => {
		const f = await start();
		const client = await session(
			f.port('submissions'),
			true,
			'bob@example.com',
		);
		await client.smtp('MAIL FROM:<bob@example.com>');
		expect(await client.smtp('RCPT TO:<postmaster>')).toStartWith(
			'550 5.1.1 No postmaster mailbox is configured here',
		);
		client.end();
	});
});

describe('submission: RCPT TO', () => {
	test('refuses with 553 5.1.3 an address the queue could not send to', async () => {
		const directory = await seededDirectory();
		try {
			const answer = checkRecipient(
				{ directory, postmaster: undefined },
				{
					address: 'bob@[192.0.2.300]',
					local: 'bob',
					domain: '[192.0.2.300]',
				},
			);
			expect(answer?.code).toBe(553);
			expect(answer?.status).toBe('5.1.3');
			expect(
				checkRecipient(
					{ directory, postmaster: undefined },
					{
						address: 'carol@elsewhere.example',
						local: 'carol',
						domain: 'elsewhere.example',
					},
				),
			).toBeUndefined();
		} finally {
			directory.close();
		}
	});
});

describe('submission: the start', () => {
	test('warns when postmaster is in a domain not hosted', async () => {
		const f = await start('postmaster = "root@elsewhere.example"');
		expect(f.lines).toContain(
			'bumail: postmaster root@elsewhere.example is in elsewhere.example, a domain not hosted here; mail for <postmaster> is refused until it is',
		);
	});
});
