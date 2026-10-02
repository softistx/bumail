import { describe, expect, test } from 'bun:test';
import { FAKE_TLS, fakeSession, mxOptions } from './session.fixtures';

describe('STARTTLS (RFC 3207)', () => {
	test('220, then TLS, then the session starts over: EHLO again (§4.2)', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('STARTTLS\r\n')).toBe(
			'220 2.0.0 Ready to start TLS\r\n',
		);
		expect(s.tlsStarts).toBe(1);
		expect(s.connection.session).toMatchObject({ secure: true, esmtp: false });
		expect(s.connection.session.helo).toBeUndefined();
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toBe(
			'503 Send EHLO first\r\n',
		);
	});

	test('commands pipelined behind STARTTLS in clear are dropped, never run (CVE-2011-0411)', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\n');
		expect(
			await s.send('STARTTLS\r\nMAIL FROM:<injected@evil.example>\r\nNOOP\r\n'),
		).toBe('220 2.0.0 Ready to start TLS\r\n');
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});

	test('not offered without tls; not twice', async () => {
		const clear = await fakeSession(mxOptions());
		await clear.send('EHLO bar.com\r\n');
		expect(await clear.send('STARTTLS\r\n')).toBe(
			'454 4.7.0 TLS not available\r\n',
		);
		const secure = await fakeSession(mxOptions({ tls: FAKE_TLS }), {
			secure: true,
		});
		await secure.send('EHLO bar.com\r\n');
		expect(await secure.send('STARTTLS\r\n')).toBe(
			'503 5.5.1 TLS already active\r\n',
		);
	});

	test('the transaction in progress is forgotten', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nSTARTTLS\r\n');
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'503 5.5.1 Send MAIL first\r\n',
		);
	});

	test('STARTTLS takes no argument: 501', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }));
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('STARTTLS now\r\n')).toBe(
			'501 5.5.4 Syntax: STARTTLS\r\n',
		);
		expect(s.tlsStarts).toBe(0);
	});

	test('what the app keeps in session.data lasts across STARTTLS', async () => {
		const seen: unknown[] = [];
		const s = await fakeSession(
			mxOptions({
				tls: FAKE_TLS,
				onConnect: (session) => {
					session.data['greylist'] = 'passed';
				},
				onMailFrom: (_, session) => {
					seen.push(session.data['greylist']);
				},
			}),
		);
		await s.send('EHLO bar.com\r\nSTARTTLS\r\n');
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(seen).toEqual(['passed']);
	});
});
