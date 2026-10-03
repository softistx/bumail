import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { failure, fakeServer, stopServers } from './client.fixtures';
import { resolveMx } from './mx';
import { MAX_ADDRESSES, sendMail } from './send';

afterEach(stopServers);

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n';
const envelope = { from: 'a@bar.com', to: 'b@foo.com', helo: 'mail.bar.com' };

/** A stream that gives one part, then nothing, ever. */
const stalled = () =>
	new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('Subject: x\r\n\r\n'));
		},
	});

describe('every wait is bounded, the caller’s own stream too', () => {
	test('a message stream that stalls times out, and hangs up before the dot', async () => {
		const { port, lines } = await fakeServer();
		const error = await failure(
			sendMail(stalled(), {
				host: '127.0.0.1',
				port,
				...envelope,
				timeouts: { dataBlock: 0.3 },
			}),
		);
		expect(error).toMatchObject({ code: 'TIMEOUT', temporary: true });
		expect(error.message).toBe(
			'Timed out after 0.3 s waiting for the next part of the message (127.0.0.1)',
		);
		expect(lines.some((line) => line.startsWith('<message'))).toBe(false);
	});

	test('a server that refuses during DATA and hangs up: its reply, not a lost connection', async () => {
		const { port } = await fakeServer({
			command(line, socket) {
				if (line !== 'DATA') return undefined;
				setTimeout(() => socket.end(), 50);
				return '354 go\r\n552 5.3.4 Too big\r\n';
			},
		});
		const error = await failure(
			sendMail(stalled(), { host: '127.0.0.1', port, ...envelope }),
		);
		expect(error).toMatchObject({ code: 'REFUSED', temporary: false });
		expect(error.message).toBe(
			'127.0.0.1 refused the message: 552 5.3.4 Too big',
		);
	});

	test('a reply trickled a line at a time still ends at its timeout', async () => {
		const { port } = await fakeServer({
			connected(socket) {
				const timer = setInterval(() => socket.write('220-wait\r\n'), 50);
				setTimeout(() => clearInterval(timer), 2000);
				return true;
			},
		});
		const start = performance.now();
		const error = await failure(
			sendMail(MESSAGE, {
				host: '127.0.0.1',
				port,
				...envelope,
				timeouts: { greeting: 0.3 },
			}),
		);
		expect(error.code).toBe('TIMEOUT');
		expect(performance.now() - start).toBeLessThan(1000);
	});
});

describe('MX delivery stays within its bounds', () => {
	test(`no more than ${MAX_ADDRESSES} addresses, and no lookup past them`, async () => {
		const { port } = await fakeServer({
			connected(socket) {
				socket.end();
				return true;
			},
		});
		const records: Record<string, { a: string[] }> = {};
		const mx = Array.from({ length: 30 }, (_, i) => {
			records[`mx${i}.foo.com`] = { a: ['127.0.0.1'] };
			return { exchange: `mx${i}.foo.com`, priority: i };
		});
		const resolver = fixtureResolver({ 'foo.com': { mx }, ...records });
		const error = await failure(
			sendMail(MESSAGE, { domain: 'foo.com', resolver, port, ...envelope }),
		);
		expect(error.code).toBe('CONNECTION_LOST');
		const lookups = resolver.queries.filter((q) => q.type === 'a');
		expect(lookups).toHaveLength(MAX_ADDRESSES);
	});

	test(`no more than ${MAX_ADDRESSES} hosts looked up, an address or not`, async () => {
		const looked = new Set<string>();
		let lookups = 0;
		const none = async (name: string) => {
			lookups++;
			looked.add(name);
			return [];
		};
		const resolver = {
			mx: async () =>
				Array.from({ length: 500 }, (_, i) => ({
					exchange: `mx${i}.foo.com`,
					priority: i,
				})),
			a: none,
			aaaa: none,
		};
		const error = await failure(
			sendMail(MESSAGE, { domain: 'foo.com', resolver, ...envelope }),
		);
		expect(error.code).toBe('DNS_FAILED');
		expect(looked.size).toBe(MAX_ADDRESSES);
		expect(lookups).toBe(2 * MAX_ADDRESSES);
	});

	test('every DNS lookup counts against the deadline', async () => {
		const never = () => new Promise<never>(() => {});
		const options = { domain: 'foo.com', ...envelope, deadline: 0.2 };
		const mx = await failure(
			sendMail(MESSAGE, {
				...options,
				resolver: { mx: never, a: never, aaaa: never },
			}),
		);
		expect(mx).toMatchObject({ code: 'TIMEOUT', temporary: true });
		expect(mx.message).toBe(
			'The deadline of 0.2 s passed waiting for the MX lookup (foo.com)',
		);
		const exchange = async () => [{ exchange: 'mx.foo.com', priority: 10 }];
		const address = await failure(
			sendMail(MESSAGE, {
				...options,
				resolver: { mx: exchange, a: never, aaaa: never },
			}),
		);
		expect(address.message).toBe(
			'The deadline of 0.2 s passed waiting for the address lookup (mx.foo.com)',
		);
	});

	test('a resolver of your own that answers with no record at all', async () => {
		const empty = {
			mx: async () => [],
			a: async () => [],
			aaaa: async () => [],
		};
		expect(await resolveMx('foo.com', empty)).toEqual([
			{ host: 'foo.com', priority: 0, implicit: true },
		]);
		const error = await failure(
			sendMail(MESSAGE, { domain: 'foo.com', resolver: empty, ...envelope }),
		);
		expect(error).toMatchObject({ code: 'DNS_FAILED', temporary: false });
		expect(error.message).toBe(
			'No mail host of foo.com has an address: no A or AAAA record',
		);
	});
});
