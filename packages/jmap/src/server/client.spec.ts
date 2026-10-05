import { afterEach, describe, expect, test } from 'bun:test';
import { alxia, trustProxy } from '@alxia/core';
import type { MailStore } from '@bumail/store';
import { CORE, MAIL, ORIGIN, openStore } from './app.fixtures';
import { jmap } from './jmap';
import type { ErrorContext, JmapClient } from './options';

/** A `Bun.Server` whose only use is naming the connection's address. */
const peer = (address: string) =>
	({
		requestIP: () => ({ address, family: 'IPv4', port: 40000 }),
	}) as unknown as Bun.Server<unknown>;

const basic = `Basic ${btoa('alice@example.com:secret')}`;

/** What each hook was told, by a server mounted in `host`. */
async function mounted(
	host: (server: ReturnType<typeof jmap>) => {
		fetch(request: Request, server?: Bun.Server<unknown>): Promise<Response>;
	},
	wrap: (store: MailStore) => MailStore = (store) => store,
) {
	const opened = await openStore('memory');
	const alice = await opened.store.createAccount('alice@example.com');
	const told = {
		authenticate: [] as JmapClient[],
		secure: [] as JmapClient[],
		onError: [] as ErrorContext[],
	};
	const server = jmap({
		store: wrap(opened.store),
		origin: ORIGIN,
		authenticate: (credentials, _request, client) => {
			told.authenticate.push(client);
			if (credentials.scheme === 'bearer' && credentials.token === 'throw')
				throw new Error('directory down');
			return alice.id;
		},
		secure: (_request, client) => {
			told.secure.push(client);
			return client.url.protocol === 'https:';
		},
		onError: (_error, context) => {
			told.onError.push(context);
		},
	});
	return { told, alice, host: host(server), close: opened.close };
}

describe('the client authenticate, secure and onError are told', () => {
	let close: (() => Promise<void>) | undefined;
	afterEach(async () => {
		await close?.();
		close = undefined;
	});

	test("is the host's ctx.ip and originalUrl(ctx): behind trustProxy, what the trusted proxy said", async () => {
		const m = await mounted((server) =>
			alxia({ proxy: trustProxy({ trusted: ['10.0.0.0/8'] }) }).plugin(server),
		);
		close = m.close;
		const response = await m.host.fetch(
			new Request('http://10.0.0.5:8080/.well-known/jmap', {
				headers: {
					authorization: basic,
					'x-forwarded-for': '::ffff:203.0.113.7',
					'x-forwarded-proto': 'https',
					'x-forwarded-host': 'mail.example.com',
				},
			}),
			peer('10.0.0.1'),
		);
		expect(response.status).toBe(200);
		const [client] = m.told.authenticate;
		expect(client?.ip).toBe('203.0.113.7');
		expect(client?.url.href).toBe('https://mail.example.com/.well-known/jmap');
		expect(m.told.secure).toEqual([client as JmapClient]);
	});

	test("is the connection's without a proxy, and nothing a client sends", async () => {
		const m = await mounted((server) => alxia().plugin(server));
		close = m.close;
		const response = await m.host.fetch(
			new Request('http://mail.example.com/.well-known/jmap', {
				headers: {
					authorization: basic,
					'x-forwarded-for': '203.0.113.7',
					'x-forwarded-proto': 'https',
				},
			}),
			peer('198.51.100.4'),
		);
		// Not over TLS by the client's say-so: Basic is refused before authenticate.
		expect(response.status).toBe(403);
		expect(m.told.secure.map(({ ip, url }) => [ip, url.protocol])).toEqual([
			['198.51.100.4', 'http:'],
		]);
		expect(m.told.authenticate).toEqual([]);
	});

	test('is unknown with no server, its URL the request’s', async () => {
		const m = await mounted((server) => alxia().plugin(server));
		close = m.close;
		await m.host.fetch(
			new Request(`${ORIGIN}/.well-known/jmap`, {
				headers: { authorization: 'Bearer abc' },
			}),
		);
		const [client] = m.told.authenticate;
		expect(client?.ip).toBeUndefined();
		expect(client?.url.href).toBe(`${ORIGIN}/.well-known/jmap`);
	});

	test('reaches onError, from authenticate and from a method that fails', async () => {
		const failing = (store: MailStore): MailStore =>
			new Proxy(store, {
				get(target, key) {
					if (key === 'listMailboxes')
						return () => Promise.reject(new Error('disk gone'));
					const value = Reflect.get(target, key);
					return typeof value === 'function' ? value.bind(target) : value;
				},
			});
		const m = await mounted(
			(server) =>
				alxia({ proxy: trustProxy({ trusted: ['10.0.0.0/8'] }) }).plugin(
					server,
				),
			failing,
		);
		close = m.close;
		const send = (init: RequestInit) =>
			m.host.fetch(
				new Request(`${ORIGIN}/jmap/api`, {
					...init,
					headers: {
						'x-forwarded-for': '203.0.113.9',
						...(init.headers as Record<string, string>),
					},
				}),
				peer('10.0.0.1'),
			);
		const thrown = await send({ headers: { authorization: 'Bearer throw' } });
		expect(thrown.status).toBe(503);
		const answered = await send({
			method: 'POST',
			headers: {
				authorization: 'Bearer ok',
				'content-type': 'application/json',
			},
			body: JSON.stringify({
				using: [CORE, MAIL],
				methodCalls: [['Mailbox/get', { accountId: m.alice.id }, 'c']],
			}),
		});
		expect(((await answered.json()) as any).methodResponses[0][1]).toEqual({
			type: 'serverFail',
		});
		expect(
			m.told.onError.map(({ client, method }) => [client.ip, method]),
		).toEqual([
			['203.0.113.9', undefined],
			['203.0.113.9', 'Mailbox/get'],
		]);
	});
});
