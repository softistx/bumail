import { describe, expect, test } from 'bun:test';
import { describeMailStore } from '../contract/mail-store.fixtures';
import { MemoryMailStore } from './store';

describeMailStore('MemoryMailStore', () => new MemoryMailStore());

describe('MemoryMailStore: maxTombstones', () => {
	test('a since older than what it remembers is CANNOT_CALCULATE_CHANGES', async () => {
		const store = new MemoryMailStore({ maxTombstones: 2 });
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		const content = new TextEncoder().encode('x');
		const ids: string[] = [];
		for (let i = 0; i < 3; i++)
			ids.push((await store.addMessage(inbox.id, { content })).id);
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.destroyMessages(ids);
		await expect(
			store.messageChanges(account.id, modseq),
		).rejects.toMatchObject({
			code: 'CANNOT_CALCULATE_CHANGES',
		});
		const latest = await store.messageChanges(account.id, modseq + 2);
		expect(latest.destroyed).toEqual([ids[2] as string]);
	});

	test('refuses a bad count', () => {
		expect(() => new MemoryMailStore({ maxTombstones: -1 })).toThrow(
			'maxTombstones',
		);
	});
});
