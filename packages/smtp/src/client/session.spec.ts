import { afterEach, describe, expect, test } from 'bun:test';
import {
	type FakeScript,
	failure,
	fakeServer,
	stopServers,
} from './client.fixtures';
import type { SendMailEnvelope } from './options';
import { sendMail } from './send';

afterEach(stopServers);

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n';
const PASSWORD = 'secret';
const auth = { username: 'alice', password: PASSWORD };
const authed = (line: string) => line.startsWith('AUTH');
const encoded = (line: string) => line.includes('AGFsaWNlAHNlY3JldA==');

/** Sends to a fake server: what it rejected with, and the lines it was sent. */
async function against(script: FakeScript, options: Partial<SendMailEnvelope>) {
	const { port, lines } = await fakeServer(script);
	const error = await failure(
		sendMail(MESSAGE, {
			host: '127.0.0.1',
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
			...options,
		}),
	);
	return { error, lines };
}

describe('AUTH, never to a certificate that was not checked', () => {
	test("tls: 'required' and no STARTTLS: TLS_UNAVAILABLE, no AUTH line, no password", async () => {
		const { error, lines } = await against(
			{ ehlo: ['AUTH PLAIN LOGIN'] },
			{ auth },
		);
		expect(error).toMatchObject({ code: 'TLS_UNAVAILABLE', temporary: true });
		expect(error.message).toBe(
			"127.0.0.1 does not offer STARTTLS, and tls is 'required'",
		);
		expect(error.message).not.toContain(PASSWORD);
		expect(lines.some(authed)).toBe(false);
		expect(lines.some(encoded)).toBe(false);
	});

	test("tls: 'required' and STARTTLS refused with 454: TLS_UNAVAILABLE, no AUTH line", async () => {
		const { error, lines } = await against(
			{
				ehlo: ['STARTTLS', 'AUTH PLAIN LOGIN'],
				command: (line) =>
					line === 'STARTTLS' ? '454 4.7.0 TLS not available\r\n' : undefined,
			},
			{ auth },
		);
		expect(error).toMatchObject({ code: 'TLS_UNAVAILABLE', temporary: true });
		expect(error.message).toBe(
			"127.0.0.1 refused STARTTLS, and tls is 'required': 454 4.7.0 TLS not available",
		);
		expect(error.message).not.toContain(PASSWORD);
		expect(lines.some(authed)).toBe(false);
	});

	test("tls: 'opportunistic' with auth is refused before connecting", async () => {
		const { error, lines } = await against(
			{ ehlo: ['AUTH PLAIN LOGIN'] },
			{ auth, tls: 'opportunistic' },
		);
		expect(error).toMatchObject({ code: 'INVALID_OPTION', temporary: false });
		expect(error.message).not.toContain(PASSWORD);
		expect(lines).toEqual([]);
	});

	test('allowPlaintextAuth: AUTH in clear, for a local test server', async () => {
		const { port, lines } = await fakeServer({
			ehlo: ['AUTH PLAIN LOGIN'],
			command: (line) => (authed(line) ? '235 ok\r\n' : undefined),
		});
		const result = await sendMail(MESSAGE, {
			host: '127.0.0.1',
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
			auth,
			allowPlaintextAuth: true,
		});
		expect(result).toMatchObject({ authenticated: true, tls: false });
		expect(lines).toContain('AUTH PLAIN AGFsaWNlAHNlY3JldA==');
	});
});

describe('a refusal mid-pipeline (RFC 2920)', () => {
	test('MAIL FROM refused: REFUSED, permanent, then QUIT; no DATA', async () => {
		const { error, lines } = await against(
			{
				ehlo: ['PIPELINING'],
				command: (line) =>
					line.startsWith('MAIL')
						? '550 5.7.1 Sender refused\r\n'
						: line.startsWith('RCPT')
							? '503 5.5.1 No sender\r\n'
							: undefined,
			},
			{ to: ['b@foo.com', 'c@foo.com'] },
		);
		expect(error).toMatchObject({ code: 'REFUSED', temporary: false });
		expect(error.message).toBe(
			'127.0.0.1 refused the sender: 550 5.7.1 Sender refused',
		);
		await Bun.sleep(50);
		expect(lines).toContain('QUIT');
		expect(lines).not.toContain('DATA');
	});
});
