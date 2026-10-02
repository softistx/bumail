import { describe, expect, test } from 'bun:test';
import { fakeSession, mxOptions } from './session.fixtures';

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
		expect(s.received[0]?.text ?? '').toEndWith('\r\nhello\r\n');
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
