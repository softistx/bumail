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
			ids.push((await store.addMessage(account.id, inbox.id, { content })).id);
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.destroyMessages(account.id, ids);
		await expect(
			store.messageChanges(account.id, modseq),
		).rejects.toMatchObject({
			code: 'CANNOT_CALCULATE_CHANGES',
		});
		const latest = await store.messageChanges(account.id, modseq + 2);
		expect(latest.destroyed).toEqual([ids[2] as string]);
	});

	test('since 0 is still answered once tombstones are forgotten: the whole state', async () => {
		const store = new MemoryMailStore({ maxTombstones: 0 });
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		const content = new TextEncoder().encode('x');
		const kept = await store.addMessage(account.id, inbox.id, { content });
		const gone = await store.addMessage(account.id, inbox.id, { content });
		await store.destroyMessages(account.id, [gone.id]);
		expect(await store.messageChanges(account.id, 0)).toMatchObject({
			created: [kept.id],
			destroyed: [],
			expunged: [],
		});
		expect((await store.mailboxChanges(account.id, 0)).created).toEqual([
			inbox.id,
		]);
	});

	test('a since-0 page never ends below what it remembers', async () => {
		const store = new MemoryMailStore({ maxTombstones: 0 });
		const account = await store.createAccount('mary@example.net');
		const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
		const add = async (text: string) =>
			(
				await store.addMessage(account.id, inbox.id, {
					content: new TextEncoder().encode(text),
				})
			).id;
		const kept = [await add('a'), await add('b'), await add('c')];
		await store.destroyMessages(account.id, [await add('d')]);
		kept.push(await add('e'));
		const created: string[] = [];
		let since = 0;
		for (let more = true; more; ) {
			const page = await store.messageChanges(account.id, since, {
				limit: 1,
			});
			created.push(...page.created);
			since = page.modseq;
			more = page.hasMore;
		}
		expect(created).toEqual(kept);
	});

	test('refuses a bad count', () => {
		expect(() => new MemoryMailStore({ maxTombstones: -1 })).toThrow(
			'maxTombstones',
		);
	});
});
