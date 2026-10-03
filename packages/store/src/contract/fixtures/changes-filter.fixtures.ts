import { describe, expect, test } from 'bun:test';
import type { MailStore } from '../mail-store';
import type { MessageChangesOptions } from '../types';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeChangesFilter(create: CreateStore): void {
	describe('changes of one mailbox', () => {
		filter(create);
		refusals(create);
		limits(create);
	});
}

/** Every page from `since` on, with each page's size. */
async function walk(
	store: MailStore,
	accountId: string,
	since: number,
	options: MessageChangesOptions,
) {
	const seen = {
		created: [] as string[],
		updated: [] as string[],
		destroyed: [] as string[],
		expunged: [] as unknown[],
		sizes: [] as number[],
		modseq: since,
	};
	for (let more = true; more; ) {
		const page = await store.messageChanges(accountId, seen.modseq, options);
		seen.created.push(...page.created);
		seen.updated.push(...page.updated);
		seen.destroyed.push(...page.destroyed);
		seen.expunged.push(...page.expunged);
		seen.sizes.push(
			page.created.length +
				page.updated.length +
				page.destroyed.length +
				page.expunged.length,
		);
		seen.modseq = page.modseq;
		more = page.hasMore;
	}
	return seen;
}

function filter(create: CreateStore): void {
	test('a message moved in is created there, one moved out destroyed', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const add = (mailboxId: string, text: string) =>
			store.addMessage(account.id, mailboxId, { content: bytes(text) });
		const flagged = await add(inbox.id, 'flagged');
		const moved = await add(inbox.id, 'moved');
		await add(a.id, 'still');
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.setFlags(account.id, [flagged.id], { add: ['\\Flagged'] });
		await store.moveMessages(account.id, [moved.id], inbox.id, a.id);
		const added = await add(inbox.id, 'added');
		const changes = (mailboxId: string) =>
			store.messageChanges(account.id, modseq, { mailboxId });
		const inInbox = await changes(inbox.id);
		expect(inInbox).toMatchObject({
			created: [added.id],
			updated: [flagged.id],
			destroyed: [moved.id],
			expunged: [{ messageId: moved.id, mailboxId: inbox.id, uid: 2 }],
			hasMore: false,
		});
		expect(await changes(a.id)).toMatchObject({
			created: [moved.id],
			updated: [],
			destroyed: [],
			expunged: [],
		});
		// The account as a whole: the move is an update.
		expect(await store.messageChanges(account.id, modseq)).toMatchObject({
			created: [added.id],
			updated: [flagged.id, moved.id],
			destroyed: [],
		});
	});

	test('one that left and came back is updated; one that came and went is left out', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const back = await store.addMessage(account.id, inbox.id, {
			content: bytes('back'),
		});
		const passing = await store.addMessage(account.id, a.id, {
			content: bytes('passing'),
		});
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.moveMessages(account.id, [back.id], inbox.id, a.id);
		await store.moveMessages(account.id, [back.id], a.id, inbox.id);
		await store.linkMessages(account.id, [passing.id], inbox.id);
		await store.removeMessages(account.id, [passing.id], inbox.id);
		const changes = await store.messageChanges(account.id, modseq, {
			mailboxId: inbox.id,
		});
		expect(changes).toMatchObject({
			created: [],
			updated: [back.id],
			destroyed: [],
		});
		// RFC 7162 §3.2.6: both UIDs that left the inbox, the passing one too.
		expect(changes.expunged.map((e) => e.messageId)).toEqual([
			back.id,
			passing.id,
		]);
	});

	test('since 0, the mailbox is its whole state', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const mine = await store.addMessage(account.id, inbox.id, {
			content: bytes('mine'),
		});
		await store.addMessage(account.id, a.id, { content: bytes('other') });
		expect(
			await store.messageChanges(account.id, 0, { mailboxId: inbox.id }),
		).toMatchObject({
			created: [mine.id],
			updated: [],
			destroyed: [],
			expunged: [],
		});
	});
}

function refusals(create: CreateStore): void {
	test('a mailbox the account does not have is NOT_FOUND', async () => {
		const { store, account, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		const theirs = await store.createMailbox(other.id, { name: 'INBOX' });
		const gone = await store.createMailbox(account.id, { name: 'Gone' });
		await store.deleteMailbox(account.id, gone.id);
		for (const mailboxId of ['nope', theirs.id, gone.id]) {
			await rejects(
				store.messageChanges(account.id, 0, { mailboxId }),
				'NOT_FOUND',
			);
		}
		await rejects(
			store.messageChanges(other.id, 0, { mailboxId: inbox.id }),
			'NOT_FOUND',
		);
	});
}

function limits(create: CreateStore): void {
	test('limit counts expunged entries too', async () => {
		const { store, account, inbox } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		const brief = await store.addMessage(account.id, inbox.id, {
			content: bytes('brief'),
		});
		const { expunged } = await store.destroyMessages(account.id, [brief.id]);
		const later = await store.addMessage(account.id, inbox.id, {
			content: bytes('later'),
		});
		const first = await store.messageChanges(account.id, modseq, { limit: 1 });
		expect(first).toMatchObject({
			created: [],
			expunged,
			hasMore: true,
		});
		const rest = await store.messageChanges(account.id, first.modseq, {
			limit: 1,
		});
		expect(rest).toMatchObject({
			created: [later.id],
			expunged: [],
			hasMore: false,
		});
	});

	for (const mailboxId of [undefined, 'inbox'] as const) {
		for (const limit of [1, 2]) {
			test(`pages of ${limit}${mailboxId ? ' in one mailbox' : ''} add up to the whole answer`, async () => {
				const { store, account, inbox } = await setup(create);
				const a = await store.createMailbox(account.id, { name: 'A' });
				const add = async (text: string) =>
					(
						await store.addMessage(account.id, inbox.id, {
							content: bytes(text),
						})
					).id;
				const [m1, m2, m3] = [await add('1'), await add('2'), await add('3')];
				const { modseq } = await store.messageChanges(account.id, 0);
				await store.setFlags(account.id, [m1], { add: ['\\Seen'] });
				await store.moveMessages(account.id, [m2], inbox.id, a.id);
				const m4 = await add('4');
				await store.destroyMessages(account.id, [m3]);
				await store.linkMessages(account.id, [m4], a.id);
				await store.removeMessages(account.id, [m4], a.id);
				const options = mailboxId ? { mailboxId: inbox.id } : {};
				const whole = await store.messageChanges(account.id, modseq, options);
				const paged = await walk(store, account.id, modseq, {
					...options,
					limit,
				});
				expect(paged.modseq).toBe(whole.modseq);
				expect(paged.created).toEqual([...whole.created]);
				expect(paged.destroyed).toEqual([...whole.destroyed]);
				expect(paged.expunged).toEqual([...whole.expunged]);
				// A page may list one created, the next its later change
				// (RFC 8620 §5.2's intermediate states), so pages may update
				// what the whole answer only creates.
				expect(new Set(paged.updated)).toEqual(
					new Set([
						...whole.updated,
						...whole.created.filter((id) => paged.updated.includes(id)),
					]),
				);
				expect(new Set(paged.updated).size).toBe(paged.updated.length);
				// A page holds more only when one modseq alone does: a
				// destroy is a destroyed and an expunged entry at once.
				for (const size of paged.sizes) expect(size).toBeLessThanOrEqual(2);
				expect(paged.sizes.length).toBeGreaterThan(1);
			});
		}
	}
}
