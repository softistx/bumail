import { afterEach, describe, expect, test } from 'bun:test';
import { SmtpError } from '../errors';
import { isMailbox } from './address';
import { startServer, stopServers } from './client.fixtures';
import { sendMail } from './send';
import { settingsOf } from './settings';

afterEach(stopServers);

const takes = (address: string) => {
	try {
		settingsOf({ from: '', to: address, host: 'mx.test', helo: 'a.test' });
		return true;
	} catch {
		return false;
	}
};

describe('isMailbox', () => {
	test.each([
		'mary@example.net',
		'first.last+tag@sub.example.org',
		'"a b"@example.com',
		'user@[192.0.2.1]',
		'jöel@exämple.com',
	])('takes %p, as sendMail does', (address) => {
		expect(isMailbox(address)).toBe(true);
		expect(takes(address)).toBe(true);
	});

	test.each([
		'a(b)@c.com',
		'a,b@c.com',
		'"x@c.com',
		'a@b@c.com',
		'a@c.com,',
		'a@-c',
		'a..b@c.com',
		'<a@c.com>',
		'a@c.com\r\nRCPT TO:<b@c.com>',
		'a@c.com​',
		'@relay.example:a@c.com',
		'a@',
		'@c.com',
		'',
		`${'a'.repeat(65)}@c.com`,
	])('refuses %p: not an RFC 5321 Mailbox, no source route', (address) => {
		expect(isMailbox(address)).toBe(false);
	});

	test('refuses what is not a string', () => {
		for (const value of [undefined, null, 42, ['a@c.com'], {}]) {
			expect(isMailbox(value)).toBe(false);
		}
	});

	test('what the review found sendMail refuses, it refuses too', () => {
		for (const address of [
			'a(b)@c.com',
			'a,b@c.com',
			'"x@c.com',
			'a@b@c.com',
			'a@c.com,',
			'a@-c',
		]) {
			expect(takes(address)).toBe(false);
		}
	});
});

describe('isMailbox and sendMail agree', () => {
	const MESSAGE = 'From: a@foo.com\r\nSubject: hi\r\n\r\nhello\r\n';

	/** Whether sendMail takes `address` as the sender, and as a recipient: anything but INVALID_OPTION. */
	const sendMailTakes = async (port: number, address: string) => {
		const outcomes = await Promise.all(
			[
				{ from: address, to: 'b@foo.com' },
				{ from: 'a@foo.com', to: address },
			].map((envelope) =>
				sendMail(MESSAGE, { host: '127.0.0.1', port, ...envelope }).then(
					() => true,
					(error: unknown) =>
						!(error instanceof SmtpError && error.code === 'INVALID_OPTION'),
				),
			),
		);
		return outcomes;
	};

	test.each([
		['@x\r\nRSET\r\nNOOP:a@c.com', false],
		['"a>b"@c.com', false],
		['a\uD800@c.com', false],
		['a@[999.1.1.1]', false],
		['a@[ipv6:2001:db8::1]', true],
		['"a b"@c.com', true],
		['@a,@b:x@c.com', false],
	] as const)('%p: %p, for both', async (address, expected) => {
		const { port } = await startServer({}, true);
		expect(isMailbox(address)).toBe(expected);
		expect(await sendMailTakes(port, address)).toEqual([expected, expected]);
	});
});
