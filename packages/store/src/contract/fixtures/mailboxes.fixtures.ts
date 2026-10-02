import { describe, expect, test } from 'bun:test';
import { MAILBOX_ROLES } from '../mailbox-name';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeMailboxes(create: CreateStore): void {
	describe('mailboxes', () => {
		creating(create);
		subscribing(create);
		naming(create);
		deleting(create);
	});
}

function creating(create: CreateStore): void {
	test('start empty, subscribed, with a UIDVALIDITY of their own and a modseq of at least 1', async () => {
		const { store, account, inbox } = await setup(create);
		const sent = await store.createMailbox(account.id, {
			name: 'Sent',
			role: 'sent',
		});
		expect(inbox).toMatchObject({
			name: 'INBOX',
			role: 'inbox',
			isSubscribed: true,
			uidNext: 1,
			messages: 0,
			unseen: 0,
		});
		expect(inbox.highestModseq).toBeGreaterThanOrEqual(1);
		expect(sent.uidValidity).not.toBe(inbox.uidValidity);
		expect(await store.findMailbox(account.id, 'sent')).toEqual(sent);
		expect(await store.findMailbox(account.id, 'junk')).toBeUndefined();
		await rejects(store.findMailbox(account.id, 'spam' as never), 'INVALID');
		expect(
			(await store.listMailboxes(account.id)).map((m) => m.name).sort(),
		).toEqual(['INBOX', 'Sent']);
	});

	test('RFC 9051 §2.3.1.1: a mailbox deleted and made again gets a new UIDVALIDITY', async () => {
		const { store, account } = await setup(create);
		const first = await store.createMailbox(account.id, { name: 'Lists' });
		await store.deleteMailbox(account.id, first.id);
		const again = await store.createMailbox(account.id, { name: 'Lists' });
		expect(again.uidValidity).not.toBe(first.uidValidity);
	});

	test('RFC 6154 and RFC 8457: every role of the registry, once per account', async () => {
		const { store, account } = await setup(create);
		for (const role of MAILBOX_ROLES.filter((r) => r !== 'inbox')) {
			expect(
				(await store.createMailbox(account.id, { name: role, role })).role,
			).toBe(role);
		}
		await rejects(
			store.createMailbox(account.id, { name: 'X', role: 'spam' as never }),
			'INVALID',
		);
	});
}

function subscribing(create: CreateStore): void {
	test('RFC 9051 §6.3.7: SUBSCRIBE and UNSUBSCRIBE, each a change of the mailbox', async () => {
		const { store, account } = await setup(create);
		const lists = await store.createMailbox(account.id, {
			name: 'Lists',
			isSubscribed: false,
		});
		expect(lists.isSubscribed).toBe(false);
		const { modseq } = await store.mailboxChanges(account.id, 0);
		expect(
			(await store.setSubscribed(account.id, lists.id, true)).isSubscribed,
		).toBe(true);
		expect((await store.mailboxChanges(account.id, modseq)).updated).toEqual([
			lists.id,
		]);
		await rejects(store.setSubscribed(account.id, 'nope', true), 'NOT_FOUND');
		await rejects(
			store.setSubscribed(account.id, lists.id, 'yes' as never),
			'INVALID',
		);
	});

	test("another account's mailbox is not found", async () => {
		const { store, account, inbox } = await setup(create);
		const other = await store.createAccount('john@example.net');
		const theirs = await store.createMailbox(other.id, { name: 'Theirs' });
		await rejects(
			store.createMailbox(account.id, { name: 'X', parentId: theirs.id }),
			'NOT_FOUND',
		);
		expect(await store.getMailbox(account.id, theirs.id)).toBeUndefined();
		expect(await store.getMailbox(other.id, inbox.id)).toBeUndefined();
		await rejects(
			store.renameMailbox(account.id, theirs.id, { name: 'X' }),
			'NOT_FOUND',
		);
		await rejects(
			store.setSubscribed(account.id, theirs.id, false),
			'NOT_FOUND',
		);
		await rejects(store.deleteMailbox(account.id, theirs.id), 'NOT_FOUND');
		await rejects(store.listMessages(account.id, theirs.id), 'NOT_FOUND');
		expect(await store.getMailbox(other.id, theirs.id)).toMatchObject({
			name: 'Theirs',
			isSubscribed: true,
		});
	});
}

function naming(create: CreateStore): void {
	test('a name is unique under its parent, a role in its account', async () => {
		const { store, account } = await setup(create);
		const work = await store.createMailbox(account.id, { name: 'Work' });
		await store.createMailbox(account.id, { name: 'Work', parentId: work.id });
		await rejects(
			store.createMailbox(account.id, { name: 'Work' }),
			'ALREADY_EXISTS',
		);
		await rejects(
			store.createMailbox(account.id, { name: 'Other', role: 'inbox' }),
			'ALREADY_EXISTS',
		);
	});

	test('RFC 9051 §5.1: INBOX at the top is INBOX in any case', async () => {
		const { store, account, inbox } = await setup(create);
		await rejects(
			store.createMailbox(account.id, { name: 'inbox' }),
			'ALREADY_EXISTS',
		);
		const work = await store.createMailbox(account.id, { name: 'Work' });
		const below = await store.createMailbox(account.id, {
			name: 'inbox',
			parentId: work.id,
		});
		expect(below.name).toBe('inbox');
		await store.renameMailbox(account.id, inbox.id, { name: 'Old' });
		expect(
			(await store.createMailbox(account.id, { name: 'Inbox' })).name,
		).toBe('INBOX');
	});

	test('a name is trimmed, and refuses "/", controls and emptiness', async () => {
		const { store, account } = await setup(create);
		expect(
			(await store.createMailbox(account.id, { name: ' Lists ' })).name,
		).toBe('Lists');
		for (const name of [
			'a/b',
			'',
			'  ',
			'a\r\nb',
			'a\u0000',
			'x'.repeat(256),
		]) {
			await rejects(store.createMailbox(account.id, { name }), 'INVALID');
		}
	});
}

function deleting(create: CreateStore): void {
	test('one with messages is deleted only with removeMessages, never one with children', async () => {
		const { store, account } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, {
			name: 'B',
			parentId: a.id,
		});
		await rejects(store.deleteMailbox(account.id, a.id), 'INVALID');
		const message = await store.addMessage(account.id, b.id, {
			content: bytes('x'),
		});
		await rejects(store.deleteMailbox(account.id, b.id), 'INVALID');
		expect(await store.getMessage(account.id, message.id)).toBeDefined();
		await store.deleteMailbox(account.id, b.id, { removeMessages: true });
		expect(await store.getMessage(account.id, message.id)).toBeUndefined();
		expect(await store.readContent(account.id, message.blobId)).toBeUndefined();
		await store.deleteMailbox(account.id, a.id);
		await rejects(store.deleteMailbox(account.id, a.id), 'NOT_FOUND');
		expect(await store.getMailbox(account.id, a.id)).toBeUndefined();
	});

	test('deleting one keeps the messages that are in another mailbox too', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
		});
		await store.linkMessages(account.id, [message.id], a.id);
		await store.deleteMailbox(account.id, a.id, { removeMessages: true });
		expect(
			(await store.getMessage(account.id, message.id))?.mailboxes.map(
				(m) => m.mailboxId,
			),
		).toEqual([inbox.id]);
	});
}
