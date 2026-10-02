import { describe, expect, mock, test } from 'bun:test';
import { FAKE_TLS, fakeSession, mxOptions, plain } from './session.fixtures';

const authenticate = (credentials: { username: string; password: string }) =>
	credentials.username === 'alice' && credentials.password === 'secret';

describe('never an open relay', () => {
	test('a recipient outside localDomains is refused without AUTH: 554 5.7.1', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<victim@elsewhere.example>\r\n')).toBe(
			'554 5.7.1 Relay access denied\r\n',
		);
		expect(await s.send('DATA\r\n')).toBe('554 5.5.1 No valid recipients\r\n');
		expect(s.received).toHaveLength(0);
	});

	test('a hook that accepts everything cannot open the relay; it is not even asked', async () => {
		const onRcptTo = mock(() => undefined);
		const s = await fakeSession(mxOptions({ onRcptTo }));
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<victim@elsewhere.example>\r\n')).toStartWith(
			'554 5.7.1',
		);
		expect(onRcptTo).not.toHaveBeenCalled();
	});

	test('the local domain is matched whole and without case', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<b@FOO.COM>\r\n')).toBe('250 2.1.5 OK\r\n');
		expect(await s.send('RCPT TO:<b@evilfoo.com>\r\n')).toStartWith(
			'554 5.7.1',
		);
		expect(await s.send('RCPT TO:<b@foo.com.evil.example>\r\n')).toStartWith(
			'554 5.7.1',
		);
		expect(await s.send('RCPT TO:<b@sub.foo.com>\r\n')).toStartWith(
			'554 5.7.1',
		);
	});

	test('localDomains as a function, given the domain in lower case', async () => {
		const asked: string[] = [];
		const s = await fakeSession(
			mxOptions({
				localDomains: async (domain) => {
					asked.push(domain);
					return domain.endsWith('.foo.com');
				},
			}),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<b@Mail.Foo.com>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		expect(await s.send('RCPT TO:<b@foo.org>\r\n')).toStartWith('554 5.7.1');
		expect(asked).toEqual(['mail.foo.com', 'foo.org']);
	});

	test('a source route cannot smuggle a relay (RFC 5321 Appendix C)', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(
			await s.send('RCPT TO:<@foo.com:victim@elsewhere.example>\r\n'),
		).toStartWith('554 5.7.1');
		expect(
			await s.send('RCPT TO:<"victim@elsewhere.example"@x.example>\r\n'),
		).toStartWith('554 5.7.1');
	});

	test('an authenticated session relays', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS, authenticate }), {
			secure: true,
		});
		await s.send('EHLO bar.com\r\n');
		expect(await s.send(`AUTH PLAIN ${plain('alice', 'secret')}\r\n`)).toBe(
			'235 2.7.0 Authentication successful\r\n',
		);
		await s.send('MAIL FROM:<alice@foo.com>\r\n');
		expect(await s.send('RCPT TO:<friend@elsewhere.example>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
	});

	test('a failed AUTH does not open the relay', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS, authenticate }), {
			secure: true,
		});
		await s.send('EHLO bar.com\r\n');
		expect(await s.send(`AUTH PLAIN ${plain('alice', 'wrong')}\r\n`)).toBe(
			'535 5.7.8 Authentication credentials invalid\r\n',
		);
		await s.send('MAIL FROM:<alice@foo.com>\r\n');
		expect(await s.send('RCPT TO:<friend@elsewhere.example>\r\n')).toStartWith(
			'554 5.7.1',
		);
	});
});

describe('submission (RFC 6409)', () => {
	const submission = () =>
		mxOptions({ mode: 'submission', tls: FAKE_TLS, authenticate });

	test('MAIL needs AUTH: 530 5.7.0', async () => {
		const s = await fakeSession(submission(), { secure: true });
		await s.send('EHLO client.example\r\n');
		expect(await s.send('MAIL FROM:<alice@foo.com>\r\n')).toBe(
			'530 5.7.0 Authentication required\r\n',
		);
	});

	test('even to a local domain', async () => {
		const s = await fakeSession(submission(), { secure: true });
		await s.send('EHLO client.example\r\n');
		expect(await s.send('MAIL FROM:<x@bar.com>\r\n')).toStartWith('530');
	});

	test('after AUTH: any recipient', async () => {
		const s = await fakeSession(submission(), { secure: true });
		await s.send(
			`EHLO client.example\r\nAUTH PLAIN ${plain('alice', 'secret')}\r\nMAIL FROM:<alice@foo.com>\r\n`,
		);
		expect(await s.send('RCPT TO:<bob@elsewhere.example>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		await s.send('DATA\r\nhi\r\n.\r\n');
		expect(s.received).toHaveLength(1);
	});

	test('submission without authenticate is refused at creation', async () => {
		expect(() => fakeSession(mxOptions({ mode: 'submission' }))).toThrow(
			'createSmtpServer(): submission takes mail only from authenticated users, so it needs authenticate',
		);
	});
});
