import { describe, expect, test } from 'bun:test';
import { MemoryQueueStore } from '../memory/store';
import { createQueue } from './queue';
import { MESSAGE, NO_DNS, setup } from './queue.fixtures';

const envelope = {
	from: 'mary@example.net',
	to: ['joe@example.com', 'ann@example.org', 'bob@partner.example'],
};

describe('routing', () => {
	test('direct MX by default: the domain, the resolver, the port and TLS given', async () => {
		const { queue, sender } = setup(undefined, {
			mxPort: 2525,
			mxTls: 'required',
			timeouts: { connect: 5 },
			deadline: 60,
		});
		await queue.enqueue(MESSAGE, {
			from: 'mary@example.net',
			to: 'joe@example.com',
		});
		await queue.deliverDue();
		expect(sender.calls[0]?.options).toEqual({
			from: 'mary@example.net',
			to: ['joe@example.com'],
			helo: 'mail.example.net',
			timeouts: { connect: 5 },
			deadline: 60,
			domain: 'example.com',
			resolver: NO_DNS,
			port: 2525,
			tls: 'required',
		});
	});

	test('a smarthost for everything: around a blocked port 25', async () => {
		const auth = { username: 'mary', password: 'secret' };
		const { queue, sender } = setup(undefined, {
			route: {
				host: 'smtp.provider.example',
				port: 587,
				tls: 'required',
				auth,
			},
			resolver: undefined,
		});
		await queue.enqueue(MESSAGE, envelope);
		await queue.deliverDue();
		expect(sender.calls).toHaveLength(3);
		for (const call of sender.calls) {
			expect(call.options).toMatchObject({
				host: 'smtp.provider.example',
				port: 587,
				tls: 'required',
				auth,
			});
			expect('domain' in call.options).toBe(false);
		}
	});

	test('a route per domain, over the default; domains compared in lowercase', async () => {
		const { queue, sender } = setup(undefined, {
			routes: {
				'Partner.Example': { host: 'relay.partner.example', secure: true },
			},
		});
		await queue.enqueue(MESSAGE, envelope);
		await queue.deliverDue();
		const byDomain = Object.fromEntries(
			sender.calls.map((c) => [c.to[0], c.options]),
		);
		expect(byDomain['bob@partner.example']).toMatchObject({
			host: 'relay.partner.example',
			secure: true,
		});
		expect(byDomain['joe@example.com']).toMatchObject({
			domain: 'example.com',
		});
	});

	test('the options are checked', () => {
		const store = new MemoryQueueStore();
		const make = (options: object) => () =>
			createQueue({ store, hostname: 'mail.example.net', ...options });
		expect(make({})).toThrow(
			"The 'mx' route needs a resolver, such as @bumail/dns's nodeResolver()",
		);
		expect(
			make({ route: { host: 'relay.example' }, routes: { 'a.example': 'mx' } }),
		).toThrow("The 'mx' route needs a resolver");
		expect(make({ route: { port: 25 } })).toThrow(
			"route must be 'mx' or a smarthost with a host",
		);
		expect(
			make({ resolver: NO_DNS, routes: { 'a.example': { host: 'a b' } } }),
		).toThrow('routes["a.example"] must be');
		expect(() =>
			createQueue({ store, hostname: 'mail example', resolver: NO_DNS }),
		).toThrow("hostname must be this server's public host name");
		expect(() =>
			createQueue({ store: {} as never, hostname: 'mail.example.net' }),
		).toThrow('store must be a QueueStore');
		expect(make({ resolver: NO_DNS, concurrency: 0 })).toThrow(
			'concurrency must be an integer of at least 1, not 0',
		);
		expect(make({ resolver: NO_DNS, pollInterval: 2 ** 31 })).toThrow(
			'pollInterval must be an integer from 1 to 2147483647, not 2147483648',
		);
		expect(make({ resolver: NO_DNS, leaseMs: 2 ** 33 })).toThrow('leaseMs');
		expect(make({ resolver: NO_DNS, limits: { maxReplyText: 2000 } })).toThrow(
			'limits.maxReplyText must be an integer from 64 to 900',
		);
		expect(make({ resolver: NO_DNS, dsn: { from: 'postmaster' } })).toThrow(
			'dsn.from must be an address',
		);
		expect(make({ resolver: NO_DNS, dsn: { returnContent: 'body' } })).toThrow(
			"dsn.returnContent must be 'headers' or 'full'",
		);
	});
});
