import { afterEach, describe, expect, test } from 'bun:test';
import { fixtureResolver } from '@bumail/dns';
import { failure, fakeServer, stopServers } from './client.fixtures';
import { resolveMx } from './mx';
import { MAX_ADDRESSES, sendMail } from './send';

afterEach(stopServers);

const MESSAGE = 'Subject: hi\r\n\r\nhello\r\n';
const envelope = { from: 'a@bar.com', to: 'b@foo.com' };

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
