import { describe, expect, test } from 'bun:test';
import {
	fakeSession,
	imapOptions,
	loggedIn,
	seededStore,
} from './session.fixtures';

const plain = (text: string) => new TextEncoder().encode(text).toBase64();

async function setup(overrides: Parameters<typeof imapOptions>[2] = {}) {
	const { store, accountId } = await seededStore();
	return imapOptions(store, accountId, overrides);
}

describe('the greeting and CAPABILITY (RFC 9051 §6.1.1)', () => {
	test('on a clear connection: STARTTLS and LOGINDISABLED, no AUTH=', async () => {
		const s = await fakeSession(await setup(), { secure: false });
		expect(s.greeting).toStartWith(
			'* OK [CAPABILITY IMAP4rev1 IMAP4rev2 STARTTLS LOGINDISABLED ',
		);
		expect(s.greeting).not.toContain('AUTH=');
		expect(s.greeting).toEndWith('] imap.example.com IMAP4rev2 ready\r\n');
	});

	test('encrypted: AUTH=PLAIN and SASL-IR, until login', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('abcd CAPABILITY\r\n')).toBe(
			'* CAPABILITY IMAP4rev1 IMAP4rev2 AUTH=PLAIN SASL-IR LITERAL+ ENABLE IDLE NAMESPACE UNSELECT MOVE CHILDREN SPECIAL-USE LIST-EXTENDED LIST-STATUS ESEARCH APPENDLIMIT=26214400\r\n' +
				'abcd OK CAPABILITY completed\r\n',
		);
		await s.send('a LOGIN alice secret\r\n');
		expect(await s.send('b CAPABILITY\r\n')).not.toContain('AUTH=PLAIN');
	});
});

describe('LOGIN and AUTHENTICATE only once encrypted', () => {
	test('LOGIN in clear is refused before its credentials are read', async () => {
		let asked = 0;
		const s = await fakeSession(
			await setup({
				authenticate: () => {
					asked++;
					return null;
				},
			}),
			{ secure: false },
		);
		expect(await s.send('a001 LOGIN alice secret\r\n')).toBe(
			'a001 NO [PRIVACYREQUIRED] Log in only once TLS is on: STARTTLS first\r\n',
		);
		expect(
			await s.send(`a002 AUTHENTICATE PLAIN ${plain('\0alice\0secret')}\r\n`),
		).toStartWith('a002 NO [PRIVACYREQUIRED]');
		expect(asked).toBe(0);
	});

	test('STARTTLS (§6.2.1): commands pipelined behind it in clear are dropped', async () => {
		const s = await fakeSession(await setup(), { secure: false });
		expect(await s.send('a1 STARTTLS\r\na2 LOGIN alice secret\r\n')).toBe(
			'a1 OK Begin TLS negotiation now\r\n',
		);
		expect(s.tlsStarts).toBe(1);
		expect(s.connection.state.phase).toBe('not-authenticated');
		expect(await s.send('a3 STARTTLS\r\n')).toBe(
			'a3 BAD TLS is already on\r\n',
		);
	});

	test('LOGIN (§6.2.3): the account authenticate names', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a001 LOGIN alice secret\r\n')).toStartWith(
			'a001 OK [CAPABILITY IMAP4rev1',
		);
		expect(s.connection.session).toMatchObject({ user: 'alice', secure: true });
	});

	test('a quoted and a literal password', async () => {
		const s = await fakeSession(
			await setup({
				authenticate: ({ password }) =>
					password === 'se cr"et' ? s.connection.id : null,
			}),
		);
		expect(await s.send('a LOGIN "alice" {8}\r\n')).toBe(
			'+ Ready for literal data\r\n',
		);
		expect(await s.send('se cr"et\r\n')).toStartWith('a NO [UNAVAILABLE]');
	});

	test('AUTHENTICATE PLAIN (§6.2.2), with a continuation', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a AUTHENTICATE PLAIN\r\n')).toBe('+ \r\n');
		expect(await s.send(`${plain('\0alice\0secret')}\r\n`)).toStartWith('a OK');
	});

	test('AUTHENTICATE: * cancels, a PLAIN for another identity fails, others mechanisms are refused', async () => {
		const s = await fakeSession(await setup());
		await s.send('a AUTHENTICATE PLAIN\r\n');
		expect(await s.send('*\r\n')).toBe('a BAD Authentication cancelled\r\n');
		expect(
			await s.send(`b AUTHENTICATE PLAIN ${plain('bob\0alice\0secret')}\r\n`),
		).toStartWith('b NO [AUTHENTICATIONFAILED]');
		expect(await s.send('c AUTHENTICATE CRAM-MD5\r\n')).toStartWith(
			'c NO [CANNOT]',
		);
		expect(await s.send('d AUTHENTICATE PLAIN !!!\r\n')).toBe(
			'd BAD Cannot decode the PLAIN response\r\n',
		);
	});

	test('three failed logins and the server hangs up', async () => {
		const s = await fakeSession(await setup());
		await s.send('a LOGIN alice wrong\r\nb LOGIN alice wrong\r\n');
		expect(await s.send('c LOGIN alice wrong\r\n')).toBe(
			'c NO [AUTHENTICATIONFAILED] Authentication failed\r\n* BYE Too many failed logins, closing\r\n',
		);
		expect(s.ended).toBe(true);
	});

	test('authenticate that throws, hangs, or names no account: NO [UNAVAILABLE], told to onError', async () => {
		for (const authenticate of [
			() => {
				throw new Error('directory down');
			},
			() => new Promise<string>(() => {}),
			() => 'no-such-account',
		]) {
			const s = await fakeSession(
				await setup({ authenticate, hookTimeout: 1 }),
			);
			expect(await s.send('a LOGIN alice secret\r\n')).toBe(
				'a NO [UNAVAILABLE] Temporary authentication failure\r\n',
			);
			expect(s.errors).toHaveLength(1);
		}
	});
});

describe('states (RFC 9051 §3)', () => {
	test('a command outside its state is BAD', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('a SELECT INBOX\r\n')).toBe(
			'a BAD SELECT is not valid in the not-authenticated state\r\n',
		);
		await s.send('b LOGIN alice secret\r\n');
		expect(await s.send('c FETCH 1 FLAGS\r\n')).toBe(
			'c BAD FETCH is not valid in the authenticated state\r\n',
		);
		expect(await s.send('d LOGIN alice secret\r\n')).toBe(
			'd BAD LOGIN is not valid in the authenticated state\r\n',
		);
	});

	test('LOGOUT (§6.1.3): BYE, OK, then the server hangs up', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('A023 LOGOUT\r\n')).toBe(
			'* BYE Logging out\r\nA023 OK LOGOUT completed\r\n',
		);
		expect(s.ended).toBe(true);
		expect(await s.send('A024 NOOP\r\n')).toBe('');
	});

	test('NOOP (§6.1.2) and NAMESPACE (§6.3.10)', async () => {
		const s = await loggedIn(await setup());
		expect(await s.send('a002 NOOP\r\n')).toBe('a002 OK NOOP completed\r\n');
		expect(await s.send('A001 NAMESPACE\r\n')).toBe(
			'* NAMESPACE (("" "/")) NIL NIL\r\nA001 OK NAMESPACE completed\r\n',
		);
	});

	test('ENABLE (RFC 5161): IMAP4rev2 is enabled; CONDSTORE and the unknown are left off', async () => {
		const s = await loggedIn(await setup());
		expect(await s.send('t2 ENABLE CONDSTORE X-GOOD-IDEA IMAP4rev2\r\n')).toBe(
			'* ENABLED IMAP4rev2\r\nt2 OK ENABLE completed\r\n',
		);
		expect(s.connection.state.rev2).toBe(true);
	});

	test('no tag, a bad tag, no command, an unknown command', async () => {
		const s = await fakeSession(await setup());
		expect(await s.send('\r\n')).toBe('* BAD Missing or invalid tag\r\n');
		expect(await s.send('a+b NOOP\r\n')).toBe(
			'* BAD Missing or invalid tag\r\n',
		);
		expect(await s.send('a1\r\n')).toBe('a1 BAD Missing command\r\n');
		expect(await s.send('a2 FROB\r\n')).toBe('a2 BAD Unknown command FROB\r\n');
		expect(await s.send('a3 UID FROB 1\r\n')).toBe(
			'a3 BAD Unknown command UID FROB\r\n',
		);
		expect(await s.send('a4 NOOP extra\r\n')).toBe(
			'a4 BAD Unexpected text at the end of the command\r\n',
		);
	});
});
