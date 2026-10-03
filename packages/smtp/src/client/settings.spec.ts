import { describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import type { SendMailOptions } from './options';
import { sendMail } from './send';
import { settingsOf } from './settings';

const base = { host: '127.0.0.1', from: 'a@bar.com', to: 'b@foo.com' };

function refused(options: object): string {
	try {
		settingsOf({ ...base, ...options } as SendMailOptions);
	} catch (error) {
		expect(error).toBeInstanceOf(SmtpError);
		expect((error as SmtpError).code).toBe('INVALID_OPTION');
		return (error as SmtpError).message;
	}
	throw new Error('accepted');
}

describe('sendMail options', () => {
	test('the defaults: RFC 5321 §4.5.3.2’s timeouts, opportunistic TLS', () => {
		const settings = settingsOf(base);
		expect(settings.timeouts).toEqual({
			connect: 30,
			greeting: 300,
			command: 300,
			mail: 300,
			rcpt: 300,
			dataStart: 120,
			dataBlock: 180,
			dataEnd: 600,
		});
		expect(settings).toMatchObject({
			tls: 'opportunistic',
			deadline: 1800,
			smtputf8: false,
		});
	});

	test('TLS is required with auth or secure, unless asked otherwise', () => {
		const auth = { username: 'alice', password: 'secret' };
		expect(settingsOf({ ...base, auth }).tls).toBe('required');
		expect(settingsOf({ ...base, secure: true }).tls).toBe('required');
		expect(settingsOf({ ...base, auth, allowPlaintextAuth: true }).tls).toBe(
			'opportunistic',
		);
	});

	test('addresses: checked as RFC 5321 paths; the null sender allowed, a null recipient not', () => {
		expect(settingsOf({ ...base, from: '' }).from).toBe('');
		expect(refused({ to: '' })).toBe(
			'sendMail(): "" is not an address (local@domain)',
		);
		expect(refused({ from: 'a@b.com>\r\nRCPT TO:<x@y.com' })).toStartWith(
			'sendMail(): "a@b.com>\\r\\nRCPT TO:<x@y.com" is not an address',
		);
		expect(refused({ to: '@x\r\nRSET\r\nNOOP:a@c.com' })).toBe(
			'sendMail(): "@x\\r\\nRSET\\r\\nNOOP:a@c.com" is not an address (local@domain)',
		);
		expect(refused({ to: 'a\uD800@c.com' })).toBe(
			'sendMail(): "a\\ud800@c.com" is not an address (local@domain)',
		);
		expect(refused({ to: 'a@[999.1.1.1]' })).toBe(
			'sendMail(): "a@[999.1.1.1]" is not an address (local@domain)',
		);
		expect(refused({ to: ['b@foo.com', '@a,@b:x@c.com'] })).toBe(
			'sendMail(): "@a,@b:x@c.com" holds a source route (@host:), which RFC 5321 says a client should not send: pass "x@c.com" alone',
		);
		expect(refused({ from: '@[IPv6:2001:db8::1]:"q@r"@C.com' })).toBe(
			'sendMail(): "@[IPv6:2001:db8::1]:\\"q@r\\"@C.com" holds a source route (@host:), which RFC 5321 says a client should not send: pass "\\"q@r\\"@C.com" alone',
		);
		expect(refused({ to: '"a>b"@c.com' })).toBe(
			'sendMail(): "\\"a>b\\"@c.com" is not an address (local@domain)',
		);
		expect(refused({ to: [] })).toBe(
			'sendMail(): to must name one recipient or more',
		);
	});

	test('timeouts are bounded by what setTimeout can wait', () => {
		expect(
			settingsOf({ ...base, timeouts: { greeting: 0.5 } }).timeouts.greeting,
		).toBe(0.5);
		expect(refused({ timeouts: { rcpt: 3_000_000 } })).toBe(
			'sendMail(): timeouts.rcpt must be a number of seconds above 0 and at most 2147483, not 3000000',
		);
		expect(refused({ deadline: 0 })).toBe(
			'sendMail(): deadline must be a number of seconds above 0 and at most 2147483, not 0',
		);
	});

	test('helo: required by MX, the machine’s name by default to a host', () => {
		const mx = { ...base, host: undefined, domain: 'foo.com' };
		expect(refused(mx)).toBe(
			"sendMail(): helo is required for delivery by MX: pass your server's public name, such as helo: 'mail.example.com'",
		);
		const given = { ...mx, helo: 'mail.bar.com' } as unknown as SendMailOptions;
		expect(settingsOf(given).helo).toBe('mail.bar.com');
		expect(settingsOf(base).helo).not.toBe('');
	});

	test('helo: an address literal, IPv4 or IPv6 (RFC 5321 §4.1.3)', () => {
		for (const helo of ['[192.0.2.1]', '[IPv6:2001:db8::1]']) {
			const given = { ...base, helo } as unknown as SendMailOptions;
			expect(settingsOf(given).helo).toBe(helo);
		}
		for (const helo of ['[999.1.1.1]', '[2001:db8::1]', '[1.2.3]']) {
			expect(refused({ helo })).toBe(
				`sendMail(): helo "${helo}" is not a host name`,
			);
		}
	});

	test('auth goes over TLS that is not checked only with allowPlaintextAuth', () => {
		const auth = { username: 'alice', password: 'secret' };
		const plain = { auth, allowPlaintextAuth: true };
		for (const tls of ['opportunistic', 'none'] as const) {
			expect(settingsOf({ ...base, ...plain, tls }).tls).toBe(tls);
		}
	});

	test('contradictions and wrong values', () => {
		expect(refused({ tls: 'none', secure: true })).toBe(
			"sendMail(): secure is TLS from the first byte: it cannot go with tls: 'none'",
		);
		expect(
			refused({ tls: 'none', auth: { username: 'a', password: 'b' } }),
		).toBe(
			"sendMail(): auth with tls: 'none' would send the password in clear; pass allowPlaintextAuth: true for a local test server",
		);
		expect(
			refused({ tls: 'opportunistic', auth: { username: 'a', password: 'b' } }),
		).toBe(
			"sendMail(): auth with tls: 'opportunistic' would send the password to a server whose certificate is not checked; leave tls out to check it, or pass allowPlaintextAuth: true for a local test server",
		);
		expect(refused({ helo: 'not a name' })).toBe(
			'sendMail(): helo "not a name" is not a host name',
		);
		expect(refused({ size: -1 })).toBe(
			'sendMail(): size must be a number of bytes, not -1',
		);
	});

	test('sendMail rejects, never throws, for a wrong option, port or message', async () => {
		const port = sendMail('x\r\n', { ...base, port: 70000 });
		await expect(port).rejects.toThrow(
			'sendMail(): port must be an integer from 1 to 65535, not 70000',
		);
		const message = sendMail(42 as unknown as string, base);
		await expect(message).rejects.toThrow(
			'sendMail(): the message must be a Uint8Array, a string or a ReadableStream',
		);
		const resolver = sendMail('x\r\n', {
			...base,
			host: undefined,
			domain: 'foo.com',
			helo: 'mail.bar.com',
		} as unknown as SendMailOptions);
		await expect(resolver).rejects.toThrow(
			'sendMail(): resolver must be a Resolver, such as @bumail/dns gives',
		);
	});
});
