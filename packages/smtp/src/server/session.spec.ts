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

	test('the Received field goes on top (RFC 5321 §4.4), with the protocol of RFC 3848', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		await s.send('Subject: hi\r\n\r\nbody\r\n.\r\n');
		const content = text(s.received[0]?.content ?? new Uint8Array());
		expect(content).toMatch(
			/^Received: from bar\.com \(\[192\.0\.2\.10\]\)\r\n\tby foo\.com with ESMTP id [0-9a-f]{20}\r\n\tfor <b@foo\.com>; \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000\r\nSubject: hi\r\n/,
		);
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
	});

	test('the null reverse-path of a bounce (RFC 5321 §4.5.5)', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<>\r\n')).toBe('250 2.1.0 OK\r\n');
		await s.send('RCPT TO:<b@foo.com>\r\nDATA\r\nx\r\n.\r\n');
		expect(s.received[0]?.envelope.from).toBe('');
	});
});

describe('ESMTP parameters', () => {
	test('BODY=8BITMIME (RFC 6152) is kept on the envelope', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com> BODY=8BITMIME\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		await s.send('caf\u00e9\r\n.\r\n');
		expect(s.received[0]?.envelope.body).toBe('8BITMIME');
	});

	test('SMTPUTF8 (RFC 6531): a non-ASCII address needs it', async () => {
		const s = await fakeSession(
			mxOptions({ localDomains: ['foo.com', '例子.广告'] }),
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<jörg@bar.com>\r\n')).toBe(
			'553 5.6.7 A non-ASCII address needs SMTPUTF8\r\n',
		);
		expect(await s.send('MAIL FROM:<jörg@bar.com> SMTPUTF8\r\n')).toBe(
			'250 2.1.0 OK\r\n',
		);
		expect(await s.send('RCPT TO:<用户@例子.广告>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
	});

	test('SIZE (RFC 1870 §6): a declared size over the limit is refused at MAIL', async () => {
		const s = await fakeSession(mxOptions({ maxMessageSize: 100 }));
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com> SIZE=101\r\n')).toBe(
			'552 5.3.4 Message too big for system\r\n',
		);
		expect(await s.send('MAIL FROM:<a@bar.com> SIZE=x\r\n')).toBe(
			'501 5.5.4 Syntax: SIZE=<bytes>\r\n',
		);
		expect(await s.send('MAIL FROM:<a@bar.com> SIZE=100\r\n')).toBe(
			'250 2.1.0 OK\r\n',
		);
	});

	test('unknown parameters and parameters after HELO: 555', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com> RET=FULL\r\n')).toBe(
			'555 5.5.4 RET is not supported\r\n',
		);
		await s.send('MAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<b@foo.com> NOTIFY=NEVER\r\n')).toBe(
			'555 5.5.4 NOTIFY is not supported\r\n',
		);
		const h = await fakeSession(mxOptions());
		await h.send('HELO bar.com\r\n');
		expect(await h.send('MAIL FROM:<a@bar.com> BODY=8BITMIME\r\n')).toBe(
			'555 BODY needs EHLO\r\n',
		);
	});
});

describe('PIPELINING (RFC 2920)', () => {
	test('a whole transaction in one write, answered in order', async () => {
		const s = await fakeSession(mxOptions());
		const out = await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nRCPT TO:<c@foo.com>\r\nDATA\r\nhello\r\n.\r\nQUIT\r\n',
		);
		const codes = out
			.split('\r\n')
			.filter((line) => /^\d{3} /.test(line))
			.map((line) => line.slice(0, 3));
		expect(codes).toEqual(['250', '250', '250', '250', '354', '250', '221']);
		expect(text(s.received[0]?.content ?? new Uint8Array())).toEndWith(
			'\r\nhello\r\n',
		);
	});

	test('two messages back to back in one write', async () => {
		const s = await fakeSession(mxOptions());
		const transaction =
			'MAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\nmessage\r\n.\r\n';
		await s.send(`EHLO bar.com\r\n${transaction}${transaction}`);
		expect(s.received).toHaveLength(2);
	});

	test('commands split byte by byte', async () => {
		const s = await fakeSession(mxOptions());
		let out = '';
		for (const char of 'EHLO bar.com\r\nNOOP\r\n') out += await s.send(char);
		expect(out).toEndWith('250 2.0.0 OK\r\n');
	});

	test('a bare LF ends a command line too', async () => {
		const s = await fakeSession(mxOptions());
		expect(await s.send('NOOP\n')).toBe('250 OK\r\n');
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
