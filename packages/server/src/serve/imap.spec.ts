import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Fixture,
	LineClient,
	message,
	PASSWORD,
	sendMail,
	startServer,
} from './serve.fixtures';

let fixture: Fixture | undefined;

afterEach(async () => {
	await fixture?.stop();
	fixture = undefined;
});

const WRONG = 'not the password at all';

/** A LOGIN on a fresh IMAPS connection: its tagged reply. */
async function login(f: Fixture, password: string): Promise<string> {
	const client = await LineClient.connect(f.port('imaps'), true);
	await client.until(/^\* OK[^\n]*\n/);
	const answer = await client.imap(
		'a1',
		`LOGIN alice@example.com "${password}"`,
	);
	client.end();
	return answer;
}

describe('imaps', () => {
	test('logs a user in over TLS, and shows the message delivered on 25', async () => {
		fixture = await startServer();
		const f = fixture;
		await sendMail(
			f.port('mx'),
			{ from: 'joe@pass.example', to: ['sales@example.com'] },
			message('joe@pass.example', 'read me over IMAP'),
		);
		const client = await LineClient.connect(f.port('imaps'), true);
		expect(await client.until(/^\* OK[^\n]*\n/)).toStartWith('* OK');
		expect(
			await client.imap('a1', `LOGIN alice@example.com "${PASSWORD}"`),
		).toMatch(/a1 OK/);
		const select = await client.imap('a2', 'SELECT INBOX');
		expect(select).toContain('* 1 EXISTS');
		const fetch = await client.imap('a3', 'FETCH 1 BODY[]');
		expect(fetch).toContain('Subject: read me over IMAP');
		expect(fetch).toContain('Return-Path: <joe@pass.example>');
		expect(fetch).toMatch(/a3 OK/);
		await client.imap('a4', 'LOGOUT');
		client.end();
	});

	test('refuses a wrong password, and logs why without the password', async () => {
		fixture = await startServer();
		const f = fixture;
		expect(await login(f, WRONG)).toMatch(/a1 NO/);
		const refused = f.lines.find((line) => line.includes('login refused'));
		expect(refused).toMatch(/^imaps: login refused from \S+: password$/);
		expect(f.lines.join('\n')).not.toContain(WRONG);
	});

	test("blocks a client after the limiter's failures, the right password included", async () => {
		fixture = await startServer();
		const f = fixture;
		// The directory's limiter: 10 failures within 15 minutes.
		for (let i = 0; i < 10; i++) {
			expect(await login(f, `${WRONG} ${i}`)).toMatch(/a1 NO/);
		}
		expect(await login(f, PASSWORD)).toMatch(/a1 NO/);
		expect(f.lines.at(-1)).toMatch(/login refused from \S+: blocked$/);
		expect(f.lines.join('\n')).not.toContain(PASSWORD);
	});
});

describe('imap on 143, when turned on', () => {
	test('refuses LOGIN and AUTHENTICATE until STARTTLS, then logs in', async () => {
		fixture = await startServer('[ports]\nimap = 143');
		const f = fixture;
		const client = await LineClient.connect(f.port('imap'));
		await client.until(/^\* OK[^\n]*\n/);
		expect(await client.imap('a1', 'CAPABILITY')).toContain('LOGINDISABLED');
		expect(
			await client.imap('a2', `LOGIN alice@example.com "${PASSWORD}"`),
		).toMatch(/a2 (NO|BAD)/);
		expect(await client.imap('a3', 'AUTHENTICATE PLAIN')).toMatch(
			/a3 (NO|BAD)/,
		);
		expect(await client.imap('a4', 'STARTTLS')).toMatch(/a4 OK/);
		await client.startTls();
		expect(
			await client.imap('a5', `LOGIN alice@example.com "${PASSWORD}"`),
		).toMatch(/a5 OK/);
		client.end();
	});

	test('is off by default, as the 143 listener', async () => {
		fixture = await startServer();
		const f = fixture;
		expect(f.server.listening.map((l) => l.name)).toEqual([
			'mx',
			'submissions',
			'submission',
			'imaps',
			'https',
			'health',
		]);
	});
});
