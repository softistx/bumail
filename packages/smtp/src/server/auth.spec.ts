import { describe, expect, test } from 'bun:test';
import { FAKE_TLS, fakeSession, mxOptions, plain } from './session.fixtures';

const b64 = (text: string) => new TextEncoder().encode(text).toBase64();
const options = (overrides = {}) =>
	mxOptions({
		tls: FAKE_TLS,
		authenticate: ({ username, password }) =>
			username === 'tim' && password === 'tanstaaftanstaaf',
		...overrides,
	});

describe('AUTH only after TLS', () => {
	test('not advertised on a clear connection', async () => {
		const s = await fakeSession(options());
		const ehlo = await s.send('EHLO bar.com\r\n');
		expect(ehlo).toEndWith('250 STARTTLS\r\n');
		expect(ehlo).not.toContain('AUTH');
	});

	test('refused on a clear connection, credentials unread: 538 5.7.11 (RFC 4954 §6)', async () => {
		let asked = false;
		const s = await fakeSession(
			options({
				authenticate: () => {
					asked = true;
					return true;
				},
			}),
		);
		await s.send('EHLO bar.com\r\n');
		expect(
			await s.send(`AUTH PLAIN ${plain('tim', 'tanstaaftanstaaf')}\r\n`),
		).toBe(
			'538 5.7.11 Encryption required for requested authentication mechanism\r\n',
		);
		expect(asked).toBe(false);
	});

	test('advertised once encrypted, and gone once authenticated', async () => {
		const s = await fakeSession(options(), { secure: true });
		const ehlo = await s.send('EHLO bar.com\r\n');
		expect(ehlo).toContain('250 AUTH PLAIN LOGIN\r\n');
		expect(ehlo).not.toContain('STARTTLS');
		await s.send(`AUTH PLAIN ${plain('tim', 'tanstaaftanstaaf')}\r\n`);
		expect(await s.send('EHLO bar.com\r\n')).not.toContain('AUTH');
	});

	test('without authenticate, no AUTH at all', async () => {
		const s = await fakeSession(mxOptions({ tls: FAKE_TLS }), { secure: true });
		expect(await s.send('EHLO bar.com\r\n')).not.toContain('AUTH');
		expect(await s.send('AUTH PLAIN x\r\n')).toBe(
			'502 5.5.1 AUTH not available\r\n',
		);
	});
});

describe('AUTH PLAIN (RFC 4616) and LOGIN', () => {
	test('PLAIN with an initial response (RFC 4954 §4)', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('AUTH PLAIN AHRpbQB0YW5zdGFhZnRhbnN0YWFm\r\n')).toBe(
			'235 2.7.0 Authentication successful\r\n',
		);
		expect(s.connection.session.user).toBe('tim');
	});

	test('PLAIN after an empty challenge: 334 then the response', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('AUTH PLAIN\r\n')).toBe('334 \r\n');
		expect(await s.send('AHRpbQB0YW5zdGFhZnRhbnN0YWFm\r\n')).toStartWith('235');
	});

	test('LOGIN: username, then password', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('AUTH LOGIN\r\n')).toBe('334 VXNlcm5hbWU6\r\n');
		expect(await s.send(`${b64('tim')}\r\n`)).toBe('334 UGFzc3dvcmQ6\r\n');
		expect(await s.send(`${b64('tanstaaftanstaaf')}\r\n`)).toStartWith('235');
	});

	test('LOGIN with the username as initial response', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send(`AUTH LOGIN ${b64('tim')}\r\n`)).toBe(
			'334 UGFzc3dvcmQ6\r\n',
		);
		expect(await s.send(`${b64('tanstaaftanstaaf')}\r\n`)).toStartWith('235');
	});

	test('`*` cancels the exchange (RFC 4954 §4)', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\nAUTH LOGIN\r\n');
		expect(await s.send('*\r\n')).toBe(
			'501 5.0.0 Authentication cancelled\r\n',
		);
		expect(await s.send('NOOP\r\n')).toBe('250 2.0.0 OK\r\n');
	});

	test('an undecodable response: 501 5.5.2', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('AUTH PLAIN %%%\r\n')).toBe(
			'501 5.5.2 Cannot decode the response\r\n',
		);
	});

	test('an unknown mechanism: 504', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('AUTH CRAM-MD5\r\n')).toBe(
			'504 5.5.4 Unrecognized authentication type\r\n',
		);
	});

	test('three failures and the server hangs up', async () => {
		const s = await fakeSession(options(), { secure: true });
		await s.send('EHLO bar.com\r\n');
		const wrong = `AUTH PLAIN ${plain('tim', 'guess')}\r\n`;
		expect(await s.send(wrong)).toStartWith('535');
		expect(await s.send(wrong)).toStartWith('535');
		expect(await s.send(wrong)).toBe(
			'421 4.7.0 foo.com Too many failed authentications, closing\r\n',
		);
		expect(s.ended).toBe(true);
	});

	test('authenticate throws: 454 4.7.0, a temporary failure (RFC 4954 §6)', async () => {
		const s = await fakeSession(
			options({
				authenticate: () => {
					throw new Error('directory down');
				},
			}),
			{ secure: true },
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send(`AUTH PLAIN ${plain('tim', 'x')}\r\n`)).toBe(
			'454 4.7.0 Temporary authentication failure\r\n',
		);
		expect(s.connection.session.user).toBeUndefined();
	});

	test('order: after EHLO, once, and not during a transaction (RFC 4954 §4)', async () => {
		const s = await fakeSession(options(), { secure: true });
		expect(await s.send('AUTH PLAIN x\r\n')).toBe('503 Send EHLO first\r\n');
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(
			await s.send(`AUTH PLAIN ${plain('tim', 'tanstaaftanstaaf')}\r\n`),
		).toBe('503 5.5.1 AUTH not allowed during a transaction\r\n');
		await s.send(`RSET\r\nAUTH PLAIN ${plain('tim', 'tanstaaftanstaaf')}\r\n`);
		expect(await s.send('AUTH PLAIN x\r\n')).toBe(
			'503 5.5.1 Already authenticated\r\n',
		);
	});
});
