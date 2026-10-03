import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import {
	failure,
	fakeServer,
	startServer,
	stopServers,
} from './client.fixtures';
import { resolveMx } from './mx';
import { sendMail } from './send';

afterEach(stopServers);

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n';
const LOCAL = '127.0.0.1';

describe('resolveMx (RFC 5321 §5.1)', () => {
	test('MX records by preference, the lowest first', async () => {
		const resolver = fixtureResolver({
			'example.com': {
				mx: [
					{ exchange: 'backup.example.com', priority: 20 },
					{ exchange: 'mx.example.com', priority: 10 },
				],
			},
		});
		expect(await resolveMx('example.com', resolver)).toEqual([
			{ host: 'mx.example.com', priority: 10, implicit: false },
			{ host: 'backup.example.com', priority: 20, implicit: false },
		]);
	});

	test('no MX record: the domain itself, the implicit MX', async () => {
		const resolver = fixtureResolver({ 'example.com': { a: [LOCAL] } });
		expect(await resolveMx('Example.COM', resolver)).toEqual([
			{ host: 'example.com', priority: 0, implicit: true },
		]);
	});

	test('a null MX (RFC 7505) is a permanent NULL_MX, with no fallback to the address', async () => {
		const resolver = fixtureResolver({
			'example.com': { mx: [{ exchange: '.', priority: 0 }], a: [LOCAL] },
		});
		const error = await failure(resolveMx('example.com', resolver));
		expect(error).toMatchObject({ code: 'NULL_MX', temporary: false });
		expect(error.message).toBe(
			'example.com accepts no mail: its MX record is the null MX (RFC 7505)',
		);
	});

	test('a DNS failure is DNS_FAILED, temporary', async () => {
		const resolver = fixtureResolver({ 'example.com': { mx: 'TEMPORARY' } });
		const error = await failure(resolveMx('example.com', resolver));
		expect(error).toMatchObject({ code: 'DNS_FAILED', temporary: true });
		expect(error.message).toStartWith(
			'Could not look up the MX records of example.com: ',
		);
	});
});

describe('sendMail by MX', () => {
	test('delivers to the most preferred host', async () => {
		const { port, received } = await startServer();
		const resolver = fixtureResolver({
			'foo.com': {
				mx: [
					{ exchange: 'mx2.foo.com', priority: 20 },
					{ exchange: 'mx1.foo.com', priority: 10 },
				],
			},
			'mx1.foo.com': { a: [LOCAL] },
			'mx2.foo.com': { a: [LOCAL] },
		});
		const result = await sendMail(MESSAGE, {
			domain: 'foo.com',
			resolver,
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
		});
		expect(result).toMatchObject({
			host: 'mx1.foo.com',
			port,
			tls: { verified: false },
		});
		expect(received).toHaveLength(1);
	});

	test('no MX: delivers to the domain’s own address', async () => {
		const { port, received } = await startServer();
		const resolver = fixtureResolver({ 'foo.com': { a: [LOCAL] } });
		const result = await sendMail(MESSAGE, {
			domain: 'foo.com',
			resolver,
			port,
			from: 'a@bar.com',
			to: 'b@foo.com',
		});
		expect(result.host).toBe('foo.com');
		expect(received).toHaveLength(1);
	});

	test('the first host failing — a dropped connection, a 4xx greeting, no address — moves on', async () => {
		for (const first of ['drop', '421', 'no address'] as const) {
			const fake = await fakeServer({
				connected(socket, count) {
					if (count > 1 || first === 'no address') return undefined;
					if (first === 'drop') socket.end();
					else socket.write('421 4.3.2 busy\r\n');
					return true;
				},
			});
			const resolver = fixtureResolver({
				'foo.com': {
					mx: [
						{ exchange: 'mx1.foo.com', priority: 10 },
						{ exchange: 'mx2.foo.com', priority: 20 },
					],
				},
				'mx1.foo.com':
					first === 'no address' ? { a: 'TEMPORARY' } : { a: [LOCAL] },
				'mx2.foo.com': { a: [LOCAL] },
			});
			const result = await sendMail(MESSAGE, {
				domain: 'foo.com',
				resolver,
				port: fake.port,
				from: 'a@bar.com',
				to: 'b@foo.com',
			});
			expect(result.host).toBe('mx2.foo.com');
		}
	});

	test('a 5xx greeting stops: the next host is not tried', async () => {
		let connections = 0;
		const fake = await fakeServer({
			connected(socket) {
				connections++;
				socket.write('554 5.7.1 go away\r\n');
				return true;
			},
		});
		const resolver = fixtureResolver({
			'foo.com': {
				mx: [
					{ exchange: 'mx1.foo.com', priority: 10 },
					{ exchange: 'mx2.foo.com', priority: 20 },
				],
			},
			'mx1.foo.com': { a: [LOCAL] },
			'mx2.foo.com': { a: [LOCAL] },
		});
		const error = await failure(
			sendMail(MESSAGE, {
				domain: 'foo.com',
				resolver,
				port: fake.port,
				from: 'a@bar.com',
				to: 'b@foo.com',
			}),
		);
		expect(error).toMatchObject({ code: 'REFUSED', temporary: false });
		expect(error.message).toBe(
			'mx1.foo.com refused the connection: 554 5.7.1 go away',
		);
		expect(connections).toBe(1);
	});

	test('every host failing temporarily: the last failure, temporary', async () => {
		const fake = await fakeServer({ greeting: '421 4.3.2 busy\r\n' });
		const resolver = fixtureResolver({
			'foo.com': { mx: [{ exchange: 'mx1.foo.com', priority: 10 }] },
			'mx1.foo.com': { a: [LOCAL, LOCAL] },
		});
		const error = await failure(
			sendMail(MESSAGE, {
				domain: 'foo.com',
				resolver,
				port: fake.port,
				from: 'a@bar.com',
				to: 'b@foo.com',
			}),
		);
		expect(error).toMatchObject({ code: 'REFUSED', temporary: true });
	});

	test('a null MX fails at once; a domain with no host at all is permanent', async () => {
		const nullMx = fixtureResolver({
			'foo.com': { mx: [{ exchange: '.', priority: 0 }] },
		});
		const options = { from: 'a@bar.com', to: 'b@foo.com', domain: 'foo.com' };
		expect(
			await failure(sendMail(MESSAGE, { ...options, resolver: nullMx })),
		).toMatchObject({
			code: 'NULL_MX',
			temporary: false,
		});
		const nowhere = await failure(
			sendMail(MESSAGE, { ...options, resolver: fixtureResolver({}) }),
		);
		expect(nowhere).toMatchObject({ code: 'DNS_FAILED', temporary: false });
		expect(nowhere.message).toBe(
			'No mail host of foo.com has an address: No A foo.com record (the fixture has none)',
		);
	});
});
