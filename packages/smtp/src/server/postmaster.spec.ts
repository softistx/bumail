import { describe, expect, mock, test } from 'bun:test';
import type { Path } from '../protocol/path';
import { fakeSession, mxOptions } from './session.fixtures';

// RFC 5321 §4.5.1: "any system that includes an SMTP server supporting
// mail relaying or delivery MUST support the reserved mailbox
// "postmaster" as a case-insensitive local name" — and §4.1.1.3 lets
// RCPT TO name it with no domain: "<Postmaster>".
describe('RCPT TO:<postmaster> (RFC 5321 §4.1.1.3, §4.5.1)', () => {
	test('is taken with no domain, without AUTH, and the envelope names it "postmaster"', async () => {
		const asked: string[] = [];
		const paths: Path[] = [];
		const s = await fakeSession(
			mxOptions({
				localDomains: (domain) => {
					asked.push(domain);
					return domain === 'foo.com';
				},
				onRcptTo: (path) => {
					paths.push(path);
				},
			}),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<Postmaster>\r\n')).toBe('250 2.1.5 OK\r\n');
		await s.send('DATA\r\n');
		expect(await s.send('Subject: hi\r\n\r\nhello\r\n.\r\n')).toStartWith(
			'250',
		);
		expect(paths).toEqual([
			{
				address: 'postmaster',
				local: 'postmaster',
				domain: '',
				postmaster: true,
			},
		]);
		// No domain to look up: it is this server's own postmaster.
		expect(asked).toEqual([]);
		expect(s.received[0]?.envelope.to).toEqual(['postmaster']);
	});

	test.each(['<postmaster>', '<POSTMASTER>', '<PostMaster>'])(
		'%s, in any case',
		async (path) => {
			const s = await fakeSession(mxOptions());
			await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
			expect(await s.send(`RCPT TO:${path}\r\n`)).toBe('250 2.1.5 OK\r\n');
		},
	);

	test('onRcptTo may still refuse it', async () => {
		const s = await fakeSession(
			mxOptions({
				onRcptTo: (path) =>
					path.postmaster
						? { code: 550, text: 'No postmaster here' }
						: undefined,
			}),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<postmaster>\r\n')).toBe(
			'550 No postmaster here\r\n',
		);
	});

	test('<postmaster@domain> is an ordinary path: relaying is still refused without AUTH', async () => {
		const onRcptTo = mock((_path: Path) => undefined);
		const s = await fakeSession(mxOptions({ onRcptTo }));
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<postmaster@elsewhere.example>\r\n')).toBe(
			'554 5.7.1 Relay access denied\r\n',
		);
		expect(await s.send('RCPT TO:<Postmaster@foo.com>\r\n')).toBe(
			'250 2.1.5 OK\r\n',
		);
		expect(onRcptTo.mock.calls[0]?.[0].postmaster).toBeUndefined();
	});

	test.each([
		'<postmasters>',
		'<postmaster@>',
		'<"postmaster">',
		'<@relay.example:postmaster>',
	])('%s is not the bare postmaster: 501', async (path) => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send(`RCPT TO:${path}\r\n`)).toBe(
			'501 5.5.4 Syntax: RCPT TO:<address>\r\n',
		);
	});

	test('MAIL FROM:<postmaster> is not a reverse-path: 501', async () => {
		const s = await fakeSession(mxOptions());
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<postmaster>\r\n')).toBe(
			'501 5.5.4 Syntax: MAIL FROM:<address>\r\n',
		);
	});
});
