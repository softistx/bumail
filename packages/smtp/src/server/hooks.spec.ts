import { describe, expect, test } from 'bun:test';
import type { SmtpError } from '../errors';
import { reply } from '../protocol/reply';
import { FAKE_TLS, fakeSession, mxOptions, plain } from './session.fixtures';

const code = (error: unknown) => (error as SmtpError).code;

describe('hooks that misbehave', () => {
	test('a hook that never settles: 451 after hookTimeout, and onError is told', async () => {
		const s = await fakeSession(
			mxOptions({ hookTimeout: 1, onMailFrom: () => new Promise(() => {}) }),
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect(code(s.errors[0])).toBe('HOOK_TIMEOUT');
		expect((s.errors[0] as Error).message).toBe(
			'onMailFrom did not settle within hookTimeout (1 s)',
		);
	});

	test('a hook that answers 2xx does not read as acceptance: 451, INVALID_HOOK_REPLY', async () => {
		const s = await fakeSession(
			mxOptions({ onRcptTo: () => reply(250, '2.1.5', 'OK') }),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect(code(s.errors[0])).toBe('INVALID_HOOK_REPLY');
		expect(await s.send('DATA\r\n')).toBe('554 5.5.1 No valid recipients\r\n');
	});

	test('a hook that throws: 451, and onError gets the error itself', async () => {
		const boom = new Error('DNSBL down');
		const s = await fakeSession(
			mxOptions({
				onMailFrom: () => {
					throw boom;
				},
			}),
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toStartWith('451 4.3.0');
		expect(s.errors).toEqual([boom]);
	});

	test('localDomains that throws: 451 for that recipient, and the session goes on', async () => {
		const s = await fakeSession(
			mxOptions({
				localDomains: (domain) => {
					if (domain === 'broken.example') throw new Error('lookup failed');
					return domain === 'foo.com';
				},
			}),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<x@broken.example>\r\n')).toBe(
			'451 4.3.0 Local error in processing\r\n',
		);
		expect(await s.send('RCPT TO:<b@foo.com>\r\n')).toBe('250 2.1.5 OK\r\n');
		expect(s.ended).toBe(false);
	});

	test('localDomains that never settles is never taken as local: 451, never relayed', async () => {
		const s = await fakeSession(
			mxOptions({ hookTimeout: 1, localDomains: () => new Promise(() => {}) }),
		);
		await s.send('EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\n');
		expect(await s.send('RCPT TO:<x@elsewhere.example>\r\n')).toStartWith(
			'451',
		);
	});

	test('authenticate that throws: 454 4.7.0, and onError is told', async () => {
		const s = await fakeSession(
			mxOptions({
				tls: FAKE_TLS,
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
		expect((s.errors[0] as Error).message).toBe('directory down');
	});

	test('an onError that throws changes nothing', async () => {
		const s = await fakeSession(
			mxOptions({
				onMailFrom: () => {
					throw new Error('x');
				},
				onError: () => {
					throw new Error('the logger is down too');
				},
			}),
		);
		await s.send('EHLO bar.com\r\n');
		expect(await s.send('MAIL FROM:<a@bar.com>\r\n')).toStartWith('451');
		expect(await s.send('NOOP\r\n')).toBe('250 2.0.0 OK\r\n');
	});
});

describe('the greeting comes first (RFC 5321 §4.3.1)', () => {
	test('a client that talks before the 220 is refused, and nothing it sent runs', async () => {
		let delivered = 0;
		const s = await fakeSession(
			mxOptions({
				onConnect: () => Bun.sleep(20),
				onData: () => {
					delivered++;
				},
			}),
			{
				early:
					'EHLO bar.com\r\nMAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\nx\r\n.\r\n',
			},
		);
		expect(s.greeting).toBe('554 foo.com Talked before the greeting\r\n');
		expect(s.ended).toBe(true);
		expect(delivered).toBe(0);
	});

	test('a slow onConnect refusal still comes before anything else', async () => {
		const s = await fakeSession(
			mxOptions({
				onConnect: async () => {
					await Bun.sleep(20);
					return reply(554, '5.7.1', 'Blocked');
				},
			}),
			{ early: 'EHLO bar.com\r\n' },
		);
		expect(s.greeting).toBe('554 Blocked\r\n');
	});
});

describe('input is bounded', () => {
	test('while a hook is pending, the server stops reading past 64 KiB, then catches up', async () => {
		let release = () => {};
		const s = await fakeSession(
			mxOptions({
				onMailFrom: () =>
					new Promise<undefined>((resolve) => {
						release = () => resolve(undefined);
					}),
			}),
		);
		await s.send('EHLO bar.com\r\n');
		s.connection.receive(new TextEncoder().encode('MAIL FROM:<a@bar.com>\r\n'));
		const noop = new TextEncoder().encode('NOOP\r\n'.repeat(1000));
		for (let i = 0; i < 20; i++) s.connection.receive(noop);
		await Bun.sleep(10);
		expect(s.paused).toBe(true);
		release();
		const out = await s.send('');
		expect(s.paused).toBe(false);
		expect(out.split('250 2.0.0 OK\r\n').length - 1).toBe(20_000);
	});

	test('message bytes put back after DATA still count: the server stays paused', async () => {
		const s = await fakeSession(
			mxOptions({ hookTimeout: 5, onData: () => new Promise(() => {}) }),
			{ raw: true },
		);
		await s.send('EHLO bar.com\r\n');
		const line = `${'x'.repeat(998)}\r\n`;
		// DATA and 100 KiB of message in one chunk: the message goes back to the queue.
		s.connection.receive(
			new TextEncoder().encode(
				`MAIL FROM:<a@bar.com>\r\nRCPT TO:<b@foo.com>\r\nDATA\r\n${line.repeat(100)}`,
			),
		);
		await Bun.sleep(10);
		const more = new TextEncoder().encode(line);
		for (let i = 0; i < 70; i++) s.connection.receive(more);
		await Bun.sleep(10);
		expect(s.paused).toBe(true);
		s.connection.close();
	});
});

describe('the greeting can wait', () => {
	test('greetingDelay: a client that talks before the late 220 is refused with 554 5.5.0', async () => {
		const s = await fakeSession(mxOptions({ greetingDelay: 0.05 }), {
			early: 'EHLO bar.com\r\n',
		});
		// No enhanced code before EHLO (RFC 2034 §4).
		expect(s.greeting).toBe('554 foo.com Talked before the greeting\r\n');
		expect(s.ended).toBe(true);
	});

	test('greetingDelay: a client that waits gets the 220 after the delay', async () => {
		const started = performance.now();
		const s = await fakeSession(mxOptions({ greetingDelay: 0.05 }));
		expect(performance.now() - started).toBeGreaterThanOrEqual(45);
		expect(s.greeting).toBe('220 foo.com ESMTP ready\r\n');
	});

	test('the idle time starts again once the 220 is out, so the wait before it costs the client nothing', async () => {
		const s = await fakeSession(
			mxOptions({
				greetingDelay: 0.05,
				onConnect: () => Bun.sleep(20).then(() => undefined),
			}),
		);
		expect(s.idleRestarts).toEqual(['220 foo.com ESMTP ready\r\n']);
	});

	test('a refused connection never restarts the idle time', async () => {
		const s = await fakeSession(
			mxOptions({ onConnect: () => reply(554, undefined, 'Blocked') }),
		);
		expect(s.idleRestarts).toEqual([]);
	});

	test('greetingDelay: a refusal from onConnect goes out at once', async () => {
		const started = performance.now();
		const s = await fakeSession(
			mxOptions({
				greetingDelay: 5,
				onConnect: () => reply(554, undefined, 'Blocked'),
			}),
		);
		expect(performance.now() - started).toBeLessThan(1000);
		expect(s.greeting).toBe('554 Blocked\r\n');
	});
});

describe('AUTH acts as the user it authenticated as', () => {
	test('a PLAIN authorization identity other than the username is refused: 535', async () => {
		let asked = false;
		const s = await fakeSession(
			mxOptions({
				tls: FAKE_TLS,
				authenticate: () => {
					asked = true;
					return true;
				},
			}),
			{ secure: true },
		);
		await s.send('EHLO bar.com\r\n');
		// RFC 4616 §4's second example: Kurt asks to act as Ursel.
		expect(await s.send('AUTH PLAIN VXJzZWwAS3VydAB4aXBqM3BsbXE=\r\n')).toBe(
			'535 5.7.8 Authentication credentials invalid\r\n',
		);
		expect(asked).toBe(false);
	});

	test('the same identity twice is the username: taken', async () => {
		const s = await fakeSession(
			mxOptions({ tls: FAKE_TLS, authenticate: () => true }),
			{ secure: true },
		);
		await s.send('EHLO bar.com\r\n');
		const same = new TextEncoder().encode('tim\0tim\0pw').toBase64();
		expect(await s.send(`AUTH PLAIN ${same}\r\n`)).toStartWith('235');
	});
});
