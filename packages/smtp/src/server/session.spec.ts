import { describe, expect, test } from 'bun:test';
import { reply } from '../protocol/reply';
import { fakeSession, mxOptions } from './session.fixtures';

const text = (data: Uint8Array) => new TextDecoder().decode(data);

describe('a mail transaction', () => {
	test('RFC 5321 Appendix D.1, a typical SMTP transaction scenario', async () => {
		const s = await fakeSession(
			mxOptions({
				onRcptTo: (path) =>
					path.local === 'Green'
						? reply(550, '5.1.1', 'No such user here')
						: undefined,
			}),
		);
		expect(s.greeting).toBe('220 foo.com ESMTP ready\r\n');
		expect(await s.send('EHLO bar.com\r\n')).toStartWith(
			'250-foo.com greets bar.com\r\n',
		);
		expect(await s.send('MAIL FROM:<Smith@bar.com>\r\n')).toBe(
			'250 2.1.0 OK\r\n',
		);
		expect(await s.send('RCPT TO:<Jones@foo.com>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		expect(await s.send('RCPT TO:<Green@foo.com>\r\n')).toBe(
			'550 5.1.1 No such user here\r\n',
		);
		expect(await s.send('RCPT TO:<Brown@foo.com>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		expect(await s.send('DATA\r\n')).toBe(
			'354 End data with <CR><LF>.<CR><LF>\r\n',
		);
		expect(
			await s.send('Blah blah blah...\r\n...etc. etc. etc.\r\n.\r\n'),
		).toMatch(/^250 2\.0\.0 OK queued as [0-9a-f]{20}\r\n$/);
		expect(await s.send('QUIT\r\n')).toBe(
			'221 2.0.0 foo.com closing connection\r\n',
		);
		expect(s.ended).toBe(true);
		// QUIT is graceful: the 221 leaves whole before the hang-up.
		expect(s.aborted).toBe(false);

		const [message] = s.received;
		expect(message?.envelope).toEqual({
			from: 'Smith@bar.com',
			to: ['Jones@foo.com', 'Brown@foo.com'],
			smtputf8: false,
			body: '7BIT',
		});
		const content = text(message?.content ?? new Uint8Array());
		expect(content).toEndWith('\r\nBlah blah blah...\r\n..etc. etc. etc.\r\n');
	});

	test('HELO: replies without enhanced status codes', async () => {
		const s = await fakeSession(mxOptions());
		expect(await s.send('HELO bar.com\r\n')).toBe(
			'250 foo.com greets bar.com\r\n',
		);
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toBe('250 OK\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com> SIZE=10\r\n')).toBe(
			'503 Nested MAIL command\r\n',
		);
	});

	test('the EHLO reply lists the extensions; neither STARTTLS nor AUTH without their options', async () => {
		const s = await fakeSession(mxOptions({ maxMessageSize: 1000 }));
		expect(await s.send('EHLO bar.com\r\n')).toBe(
			'250-foo.com greets bar.com\r\n250-PIPELINING\r\n250-SIZE 1000\r\n250-8BITMIME\r\n250-SMTPUTF8\r\n250 ENHANCEDSTATUSCODES\r\n',
		);
	});

	test('commands out of order: 503 (RFC 5321 §4.1.4)', async () => {
		const s = await fakeSession(mxOptions());
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toBe(
			'503 Send EHLO first\r\n',
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
		expect(await s.send('DATA\r\n')).toBe('503 5.5.1 Send MAIL first\r\n');
		await s.send('MAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('DATA\r\n')).toBe('554 5.5.1 No valid recipients\r\n');
	});

	test('RSET and a second EHLO end the transaction', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RSET\r\n')).toBe('250 2.0.0 OK\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
		await s.send('MAIL FROM:<a@bar.com>\r\nEHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});

	test('NOOP, HELP, VRFY (252: gives away no account, RFC 5321 §3.5.3), unknown verbs', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('NOOP\r\n')).toBe('250 2.0.0 OK\r\n');
		expect(await s.send('HELP\r\n')).toBe('214 2.0.0 See RFC 5321\r\n');
		expect(await s.send('VRFY root\r\n')).toStartWith('252 2.5.0 ');
		expect(await s.send('EXPN staff\r\n')).toBe(
			'500 5.5.2 Command unrecognized\r\n',
		);
	});

	test('a bad EHLO argument', async () => {
		const s = await fakeSession(mxOptions());
		expect(await s.send('EHLO\r\n')).toBe('501 Syntax: EHLO hostname\r\n');
		expect(await s.send('EHLO bad name\r\n')).toBe(
			'501 Syntax: EHLO hostname\r\n',
		);
		expect(await s.send('EHLO [192.0.2.1]\r\n')).toStartWith('250-');
		expect(await s.send('EHLO [IPv6:2001:db8::1]\r\n')).toStartWith('250-');
		// The tag is an RFC 5234 quoted string: any case.
		expect(await s.send('EHLO [ipv6:2001:db8::1]\r\n')).toStartWith('250-');
		for (const literal of ['[999.1.1.1]', '[2001:db8::1]', '[1.2.3]']) {
			expect(await s.send(`EHLO ${literal}\r\n`)).toBe(
				'501 5.5.4 Syntax: EHLO hostname\r\n',
			);
		}
	});

	test('the null reverse-path of a bounce (RFC 5321 §4.5.5)', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<>\r\n')).toBe('250 2.1.0 OK\r\n');
		await s.send('RCPT TO:<b@foo.com>\r\nDATA\r\nx\r\n.\r\n');
		expect(s.received[0]?.envelope.from).toBe('');
	});
});

describe('hooks', () => {
	test('onConnect refuses: the reply, then the server hangs up', async () => {
		const s = await fakeSession(
			mxOptions({
				onConnect: (session) =>
					session.remoteAddress === '192.0.2.10'
						? reply(554, '5.7.1', 'Go away')
						: undefined,
			}),
		);
		expect(s.greeting).toBe('554 Go away\r\n');
		expect(s.ended).toBe(true);
	});

	test('onMailFrom refuses a sender', async () => {
		const s = await fakeSession(
			mxOptions({
				onMailFrom: (path) =>
					path.domain === 'spam.example'
						? reply(550, '5.7.1', 'No')
						: undefined,
			}),
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<x@spam.example>\r\n')).toBe(
			'550 5.7.1 No\r\n',
		);
		expect(await s.send('MAIL FROM:<x@bar.com>\r\n')).toBe('250 2.1.0 OK\r\n');
	});

	test('onData refuses the message; the next transaction starts clean', async () => {
		const s = await fakeSession(
			mxOptions({ onData: () => reply(554, '5.6.0', 'Rejected') }),
		);
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		expect(await s.send('x\r\n.\r\n')).toBe('554 5.6.0 Rejected\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});

	test('a hook that throws refuses with 451 4.3.0, a temporary failure', async () => {
		const s = await fakeSession(
			mxOptions({
				onData: async () => {
					throw new Error('disk full');
				},
			}),
		);
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		expect(await s.send('x\r\n.\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
	});

	test('a slow hook holds the replies after it, in order', async () => {
		const s = await fakeSession(
			mxOptions({
				onMailFrom: async () => {
					await Bun.sleep(20);
					return undefined;
				},
			}),
		);
		const out = await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nNOOP\r\n',
		);
		expect(out.indexOf('2.1.0')).toBeLessThan(out.indexOf('2.0.0'));
	});

	test("the session hooks see: secure, helo, esmtp, and the app's own data", async () => {
		const seen: unknown[] = [];
		const s = await fakeSession(
			mxOptions({
				onConnect: (session) => {
					session.data['score'] = 1;
				},
				onRcptTo: (_, session) => {
					seen.push({ ...session, id: typeof session.id });
				},
			}),
		);
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\n',
		);
		expect(seen).toEqual([
			{
				id: 'string',
				remoteAddress: '192.0.2.10',
				secure: false,
				esmtp: true,
				helo: 'bar.com',
				data: { score: 1 },
			},
		]);
	});
});

describe('a source route (RFC 5321 Appendix C)', () => {
	test('a valid one is accepted and discarded; one with a control or an invalid domain is a syntax error', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(
			await s.send('MAIL FROM:<@hosta.int,@jkl.org:Smith@bar.com>\r\n'),
		).toBe('250 2.1.0 OK\r\n');
		expect(await s.send('RCPT TO:<@[192.0.2.1]:Jones@foo.com>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		for (const path of [
			'<@x\x00y:Brown@foo.com>',
			'<@x\x1b:Brown@foo.com>',
			'<@a..b:Brown@foo.com>',
			'<@a,b:Brown@foo.com>',
			'<@:Brown@foo.com>',
			'<Br\x00own@foo.com>',
		]) {
			expect([path, await s.send(`RCPT TO:${path}\r\n`)]).toEqual([
				path,
				'501 5.5.4 Syntax: RCPT TO:<address>\r\n',
			]);
		}
		await s.send('DATA\r\n');
		await s.send('hi\r\n.\r\n');
		expect(s.received[0]?.envelope).toMatchObject({
			from: 'Smith@bar.com',
			to: ['Jones@foo.com'],
		});
	});
});
