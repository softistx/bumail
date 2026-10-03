import { describe, expect, test } from 'bun:test';
import type { MailStore } from '../mail-store';
import type { MessageChangesOptions } from '../types';
import { bytes, type CreateStore, setup } from './setup.fixtures';

export function describeChangesPaging(create: CreateStore): void {
	describe('changes in pages', () => {
		limitCountsExpunged(create);
		firstComingIn(create);
		pagesAddUp(create);
	});
}

function limitCountsExpunged(create: CreateStore): void {
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
		expect(first).toMatchObject({ created: [], expunged, hasMore: true });
		const rest = await store.messageChanges(account.id, first.modseq, {
			limit: 1,
		});
		expect(rest).toMatchObject({
			created: [later.id],
			expunged: [],
			hasMore: false,
		});
	});
}

/**
 * Follows every page from `since`, applying each to `held`, what the
 * client held then: created is added, destroyed removed, and updated must name one it
 * holds. Returns what it holds at the end, the expunged entries in order
 * and each page's size.
 */
async function replay(
	store: MailStore,
	accountId: string,
	since: number,
	held: Set<string>,
	filter: MessageChangesOptions,
	limit: number,
) {
	const expunged: unknown[] = [];
	const sizes: number[] = [];
	let modseq = since;
	for (let more = true; more; ) {
		const page = await store.messageChanges(accountId, modseq, {
			...filter,
			limit,
		});
		for (const id of page.created) held.add(id);
		for (const id of page.updated) expect(held.has(id)).toBe(true);
		for (const id of page.destroyed) held.delete(id);
		expunged.push(...page.expunged);
		sizes.push(
			page.created.length +
				page.updated.length +
				page.destroyed.length +
				page.expunged.length,
		);
		modseq = page.modseq;
		more = page.hasMore;
	}
	return { held, expunged, sizes, modseq };
}

function firstComingIn(create: CreateStore): void {
	test('a message that came in, left and came back is created on the page of its first coming in', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const add = async (mailboxId: string, text: string) =>
			(
				await store.addMessage(account.id, mailboxId, {
					content: bytes(text),
				})
			).id;
		const x = await add(a.id, 'x');
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.moveMessages(account.id, [x], a.id, inbox.id);
		const f1 = await add(inbox.id, 'f1');
		const f2 = await add(inbox.id, 'f2');
		await store.moveMessages(account.id, [x], inbox.id, a.id);
		await store.moveMessages(account.id, [x], a.id, inbox.id);
		const first = await store.messageChanges(account.id, modseq, {
			mailboxId: inbox.id,
			limit: 2,
		});
		expect(first).toMatchObject({ created: [x, f1], hasMore: true });
		const rest = await store.messageChanges(account.id, first.modseq, {
			mailboxId: inbox.id,
			limit: 2,
		});
		expect(rest.created).toEqual([f2]);
	});
}

function pagesAddUp(create: CreateStore): void {
	for (const filtered of [false, true]) {
		for (const limit of [1, 2]) {
			test(`pages of ${limit}${filtered ? ' in one mailbox' : ''} bring a client to the current state`, async () => {
				const { store, account, inbox } = await setup(create);
				const a = await store.createMailbox(account.id, { name: 'A' });
				const add = async (mailboxId: string, text: string) =>
					(
						await store.addMessage(account.id, mailboxId, {
							content: bytes(text),
						})
					).id;
				const [m1, m2, m3] = [
					await add(inbox.id, '1'),
					await add(inbox.id, '2'),
					await add(inbox.id, '3'),
				];
				const x = await add(a.id, 'x');
				const { modseq } = await store.messageChanges(account.id, 0);
				// What a client holds at `modseq`, taken from the messages.
				const held = new Set(
					filtered
						? (await store.listMessages(account.id, inbox.id)).map(
								(e) => e.message.id,
							)
						: [m1, m2, m3, x],
				);
				const move = (id: string, from: string, to: string) =>
					store.moveMessages(account.id, [id], from, to);
				await move(x, a.id, inbox.id);
				await store.setFlags(account.id, [m1], { add: ['\\Seen'] });
				await move(m2, inbox.id, a.id);
				const m4 = await add(inbox.id, '4');
				await move(x, inbox.id, a.id);
				await move(x, a.id, inbox.id);
				await store.destroyMessages(account.id, [m3]);
				await move(m1, inbox.id, a.id);
				await move(m1, a.id, inbox.id);
				await move(m2, a.id, inbox.id);
				await move(m2, inbox.id, a.id);
				await store.linkMessages(account.id, [m4], a.id);
				await store.removeMessages(account.id, [m4], a.id);
				const options = filtered ? { mailboxId: inbox.id } : {};
				const whole = await store.messageChanges(account.id, modseq, options);
				const now = await store.messageChanges(account.id, 0, options);
				const paged = await replay(
					store,
					account.id,
					modseq,
					held,
					options,
					limit,
				);
				expect(paged.modseq).toBe(whole.modseq);
				expect([...paged.held].sort()).toEqual([...now.created].sort());
				expect(paged.expunged).toEqual([...whole.expunged]);
				// A page holds more only when one modseq alone does: a move
				// is an expunged entry and a change at once.
				for (const size of paged.sizes) expect(size).toBeLessThanOrEqual(2);
				expect(paged.sizes.length).toBeGreaterThan(1);
			});
		}
	}
}
