import { describe, expect, test } from 'bun:test';
import { type CreateStore, rejects, setup } from './setup.fixtures';

export function describeRenames(create: CreateStore): void {
	describe('mailbox renames', () => {
		renaming(create);
	});
}

function renaming(create: CreateStore): void {
	test('a rename keeps what it leaves out, and parentId null moves to the top', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, {
			name: 'B',
			parentId: a.id,
		});
		expect(
			await store.renameMailbox(account.id, b.id, { name: 'B2' }),
		).toMatchObject({ name: 'B2', parentId: a.id, uidValidity: b.uidValidity });
		const top = await store.renameMailbox(account.id, b.id, { parentId: null });
		expect(top.name).toBe('B2');
		expect(top).not.toHaveProperty('parentId');
		expect(
			await store.renameMailbox(account.id, b.id, { parentId: a.id }),
		).toMatchObject({ name: 'B2', parentId: a.id });
		expect(
			await store.renameMailbox(account.id, inbox.id, { name: 'Received' }),
		).toMatchObject({ role: 'inbox' });
		await rejects(
			// @ts-expect-error a rename names a name, a parentId or both, so `{}` does not compile
			store.renameMailbox(account.id, a.id, {}),
			'INVALID',
		);
		await rejects(
			store.renameMailbox(account.id, a.id, null as never),
			'INVALID',
		);
		await rejects(
			store.renameMailbox(account.id, a.id, { parentId: 5 as never }),
			'INVALID',
		);
	});

	test('never inside themselves, onto a taken name, or under a missing parent', async () => {
		const { store, account } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, {
			name: 'B',
			parentId: a.id,
		});
		await rejects(
			store.renameMailbox(account.id, a.id, { parentId: b.id }),
			'INVALID',
		);
		await rejects(
			store.renameMailbox(account.id, a.id, { parentId: a.id }),
			'INVALID',
		);
		await rejects(
			store.renameMailbox(account.id, a.id, { name: 'INBOX' }),
			'ALREADY_EXISTS',
		);
		await rejects(
			store.renameMailbox(account.id, 'nope', { name: 'X' }),
			'NOT_FOUND',
		);
		await rejects(
			store.renameMailbox(account.id, a.id, { parentId: 'nope' }),
			'NOT_FOUND',
		);
		const still = await store.getMailbox(account.id, a.id);
		expect(still?.name).toBe('A');
		expect(still).not.toHaveProperty('parentId');
	});
}
