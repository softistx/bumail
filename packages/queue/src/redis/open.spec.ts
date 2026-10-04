import { describe, expect, test } from 'bun:test';
import { entry, MINUTE, T0 } from '../contract/fixtures/setup.fixtures';
import type { RedisQueueClient } from './options';
import { describeRedis, temporaryStores } from './servers.fixtures';
import { RedisQueueStore } from './store';

// A `Bun.RedisClient` is what the store takes, though its type names none:
// a change on either side that breaks the fit fails typecheck here.
const fits = (client: Bun.RedisClient): RedisQueueClient => client;

/** Nothing listens on port 1: every connection is refused at once. */
const NOWHERE = 'redis://bumail:secret@127.0.0.1:1/0';

const NEEDS =
	'A Redis queue store needs client, a Bun.RedisClient, or url, a redis:// URL';

describe('RedisQueueStore.open', () => {
	test('refuses what is not a client nor a redis:// URL, never echoing the URL', () => {
		const open = (options: unknown) => () =>
			RedisQueueStore.open(options as { url: string });
		expect(open(undefined)).toThrow(NEEDS);
		expect(open({})).toThrow(NEEDS);
		expect(open({ url: 'not a url' })).toThrow(NEEDS);
		expect(open({ url: 'http://bumail:secret@localhost/' })).toThrow(NEEDS);
		expect(open({ url: 'http://bumail:secret@localhost/' })).not.toThrow(
			'secret',
		);
		expect(open({ client: { send() {} } })).toThrow(NEEDS);
		expect(
			open({ client: fits(new Bun.RedisClient(NOWHERE)), url: NOWHERE }),
		).toThrow('A Redis queue store takes client or url, not both');
	});

	test('a URL Bun.RedisClient refuses is INVALID, the password never repeated', () => {
		const open = () =>
			RedisQueueStore.open({ url: 'redis://bumail:secret@127.0.0.1:1/x' });
		expect(open).toThrow(
			'The URL in url cannot be opened: Invalid database number in Redis URL',
		);
		expect(open).toThrow(expect.objectContaining({ code: 'INVALID' }));
		expect(open).not.toThrow('secret');
		expect(open).not.toThrow('127.0.0.1');
	});

	test('refuses a key prefix Redis or a SCAN would read specially', () => {
		for (const keyPrefix of [
			'Queue:',
			'1q:',
			'{queue}:',
			'q*',
			'q?',
			'q[a]',
			'q\\',
			'q :',
			'q\r\n',
			'q\u0000',
			'q\ud83d',
			'é:',
			'',
			'x'.repeat(41),
		]) {
			expect(() => RedisQueueStore.open({ url: NOWHERE, keyPrefix })).toThrow(
				`keyPrefix must be lowercase letters, digits, '_', ':', '.' and '-', starting with a letter, at most 40 characters, not ${JSON.stringify(keyPrefix)}`,
			);
		}
		expect(() =>
			RedisQueueStore.open({ url: NOWHERE, keyPrefix: 7 as unknown as string }),
		).toThrow('keyPrefix must be');
	});

	test('connects to nothing until used; a server out of reach is INVALID, and tried again', async () => {
		const client = new Bun.RedisClient(NOWHERE, { maxRetries: 0 });
		const store = RedisQueueStore.open({ client: fits(client) });
		const first = store.count();
		await expect(first).rejects.toMatchObject({
			code: 'INVALID',
			message: expect.stringContaining('The Redis queue cannot be set up:'),
		});
		await expect(first).rejects.not.toThrow('secret');
		await expect(store.add(entry())).rejects.toMatchObject({
			code: 'INVALID',
		});
		await store.close();
		await store.close();
		await expect(store.count()).rejects.toMatchObject({ code: 'CLOSED' });
		await expect(
			store.claim({ owner: 'w', now: T0, leaseMs: MINUTE }),
		).rejects.toMatchObject({ code: 'CLOSED' });
		client.close();
	});
});

describeRedis('RedisQueueStore on Redis', (url) => {
	const { admin, client, create, prefix, prefixFor, share } =
		temporaryStores(url);

	test('an item, its message, byte for byte, and its lease outlive the instance', async () => {
		const first = create();
		// Every byte value, and sequences no UTF-8 decoder would give back.
		const bytes = Uint8Array.from({ length: 256 * 1024 }, (_, i) =>
			i < 256 ? i : (i * 7919) % 256,
		);
		const item = await first.add(entry({ message: bytes }));
		await first.claim({ owner: 'w1', now: T0, leaseMs: MINUTE });
		await first.close();
		const again = share(first);
		expect((await again.get(item.id))?.lease?.owner).toBe('w1');
		const read = await again.readMessage(item.id);
		expect(read?.constructor).toBe(Uint8Array);
		expect(read).toEqual(bytes);
	});

	test('keys from a newer store are refused', async () => {
		const store = create();
		await store.count();
		await admin.send('SET', [`${prefixFor(store)}schema`, '2']);
		const later = share(store);
		await expect(later.count()).rejects.toThrow(
			"The database is at schema version 2, newer than this store's 1",
		);
	});

	test('close leaves a client it was given open, and closes one it opened', async () => {
		const given = client();
		const store = RedisQueueStore.open({ client: given, keyPrefix: prefix() });
		await store.count();
		await store.close();
		expect(await given.send('PING', [])).toBe('PONG');
		const owned = RedisQueueStore.open({
			url: new URL(url),
			keyPrefix: prefix(),
		});
		await owned.add(entry());
		expect(await owned.count()).toBe(1);
		await owned.close();
		await expect(owned.count()).rejects.toMatchObject({ code: 'CLOSED' });
	});

	test('a script Redis lost (a restart, a failover, SCRIPT FLUSH) is sent again', async () => {
		const store = create();
		await store.add(entry());
		await admin.send('SCRIPT', ['FLUSH']);
		const claimed = await store.claim({ owner: 'w', now: T0, leaseMs: MINUTE });
		expect(claimed?.lease?.owner).toBe('w');
	});
});
