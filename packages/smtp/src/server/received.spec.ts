import { describe, expect, test } from 'bun:test';
import { addressLiteral, dateTime, protocolOf } from './received';
import { FAKE_TLS, fakeSession, mxOptions, plain } from './session.fixtures';

describe('the Received field (RFC 5321 §4.4)', () => {
	test('the Received field goes on top (RFC 5321 §4.4), with the protocol of RFC 3848', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		await s.send('Subject: hi\r\n\r\nbody\r\n.\r\n');
		const content = s.received[0]?.text ?? '';
		expect(content).toMatch(
			/^Received: from bar\.com \(\[192\.0\.2\.10\]\)\r\n\tby foo\.com with ESMTP id [0-9a-f]{20}\r\n\tfor <b@foo\.com>; \w{3}, \d{1,2} \w{3} \d{4} \d\d:\d\d:\d\d \+0000\r\nSubject: hi\r\n/,
		);
	});

	test('the Received field leaves out a recipient it cannot print as it is', async () => {
		const s = await fakeSession(mxOptions());
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<"x;y"@foo.com>\r\nDATA\r\n',
		);
		await s.send('hi\r\n.\r\n');
		const head = s.received[0]?.text.split('\r\nhi')[0] ?? '';
		expect(head).not.toContain('for <');
		expect(head).toMatch(/id [0-9a-f]{20}; \w{3}, /);
	});

	test('an IPv6 client is the literal of RFC 5321 §4.1.3, tagged IPv6:', async () => {
		const s = await fakeSession(mxOptions(), { remoteAddress: '2001:db8::7' });
		await s.send(
			'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n',
		);
		await s.send('hi\r\n.\r\n');
		expect(s.received[0]?.text).toStartWith(
			'Received: from bar.com ([IPv6:2001:db8::7])\r\n',
		);
		expect(addressLiteral('192.0.2.10')).toBe('192.0.2.10');
		expect(addressLiteral('')).toBe('');
		// A zone is no part of the literal.
		expect(addressLiteral('fe80::1%en0')).toBe('IPv6:fe80::1');
	});

	test('with, per RFC 3848: SMTP, ESMTP, ESMTPS, ESMTPSA', () => {
		expect(protocolOf(false, false, false)).toBe('SMTP');
		expect(protocolOf(true, false, false)).toBe('ESMTP');
		expect(protocolOf(true, true, false)).toBe('ESMTPS');
		expect(protocolOf(true, true, true)).toBe('ESMTPSA');
	});

	test('the date is RFC 5322 §3.3 date-time, in UTC', () => {
		expect(dateTime(new Date(Date.UTC(2026, 9, 2, 8, 5, 9)))).toBe(
			'Fri, 2 Oct 2026 08:05:09 +0000',
		);
	});

	test('an authenticated session over TLS says ESMTPSA', async () => {
		const s = await fakeSession(
			mxOptions({ tls: FAKE_TLS, authenticate: () => true }),
			{ secure: true },
		);
		await s.send(
			`EHLO bar.com\r\nAUTH PLAIN ${plain('tim', 'pw')}\r\nMAIL FROM:<tim@foo.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\nhi\r\n.\r\n`,
		);
		expect(s.received[0]?.text).toContain('with ESMTPSA id');
	});
});
