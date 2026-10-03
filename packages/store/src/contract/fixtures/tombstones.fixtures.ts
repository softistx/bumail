import { describe, expect, test } from 'bun:test';
import type { MailStore } from '../mail-store';
import { bytes } from './setup.fixtures';

/** A store that remembers at most `max` removals. */
export type CreateForgetful = (max: number) => Promise<MailStore> | MailStore;

/**
 * The floor: what a store that forgets old removals still owes. Run only
 * for a store that can be made to forget.
 */
export function describeTombstones(createForgetful: CreateForgetful): void {
	describe('a store that forgets removals', () => {
		test('a since older than what it remembers is CANNOT_CALCULATE_CHANGES', async () => {
			const store = await createForgetful(2);
			const account = await store.createAccount('mary@example.net');
			const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
			const ids: string[] = [];
			for (let i = 0; i < 3; i++)
				ids.push(
					(
						await store.addMessage(account.id, inbox.id, {
							content: bytes('x'),
						})
					).id,
				);
			const { modseq } = await store.messageChanges(account.id, 0);
			await store.destroyMessages(account.id, ids);
			await expect(
				store.messageChanges(account.id, modseq),
			).rejects.toMatchObject({ code: 'CANNOT_CALCULATE_CHANGES' });
			await expect(
				store.messageChanges(account.id, modseq, { mailboxId: inbox.id }),
			).rejects.toMatchObject({ code: 'CANNOT_CALCULATE_CHANGES' });
			const latest = await store.messageChanges(account.id, modseq + 2);
			expect(latest.destroyed).toEqual([ids[2] as string]);
			const inInbox = await store.messageChanges(account.id, modseq + 2, {
				mailboxId: inbox.id,
			});
			expect(inInbox.destroyed).toEqual([ids[2] as string]);
		});

		test('since 0 is still answered once removals are forgotten: the whole state', async () => {
			const store = await createForgetful(0);
			const account = await store.createAccount('mary@example.net');
			const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
			const kept = await store.addMessage(account.id, inbox.id, {
				content: bytes('x'),
			});
			const gone = await store.addMessage(account.id, inbox.id, {
				content: bytes('x'),
			});
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

		for (const filtered of [false, true])
			test(`a since-0 page${filtered ? ' of one mailbox' : ''} never ends below what it remembers`, async () => {
				const store = await createForgetful(0);
				const account = await store.createAccount('mary@example.net');
				const inbox = await store.createMailbox(account.id, { name: 'INBOX' });
				const add = async (text: string) =>
					(
						await store.addMessage(account.id, inbox.id, {
							content: bytes(text),
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
						...(filtered ? { mailboxId: inbox.id } : {}),
					});
					created.push(...page.created);
					since = page.modseq;
					more = page.hasMore;
				}
				expect(created).toEqual(kept);
			});
	});
}
