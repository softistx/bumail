import { expect, test } from 'bun:test';
import { MemoryMailStore } from '@bumail/store';
import { trackedStore } from './tracked';

test('keeps each store call under way until it settles, failures included', async () => {
	const pending = new Set<Promise<unknown>>();
	const store = trackedStore(new MemoryMailStore(), pending);
	const created = store.createAccount('alice@example.com');
	expect(pending.size).toBe(1);
	await created;
	await Bun.sleep(0);
	expect(pending.size).toBe(0);
	const missing = store.deleteAccount('nobody');
	expect(pending.size).toBe(1);
	await missing.catch(() => {});
	await Bun.sleep(0);
	expect(pending.size).toBe(0);
});
