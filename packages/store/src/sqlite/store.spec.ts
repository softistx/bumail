import { describe, expect, test } from 'bun:test';
import { describeRenames } from '../contract/fixtures/renames.fixtures';
import { rejects, setup } from '../contract/fixtures/setup.fixtures';
import { MAILBOX_ROLES } from '../contract/mailbox-name';
import { temporaryStores } from './directories.fixtures';

const { open } = temporaryStores();
const create = () => open();

// The contract's own specs, for those that touch no message yet; the
// account and mailbox specs below mirror the rest of theirs, leaving out
// what needs a message, until the messages slice runs describeMailStore.
describe('SqliteMailStore: the MailStore contract, so far', () => {
	describeRenames(create);
});

describe('SqliteMailStore: accounts', () => {
	test('are found by id and by login, case-insensitively', async () => {
		const { store, account } = await setup(create);
		expect(await store.getAccount(account.id)).toEqual(account);
		expect(await store.findAccount('MARY@example.NET')).toEqual(account);
		expect(await store.findAccount('nobody@example.net')).toBeUndefined();
		expect(await store.getAccount('nope')).toBeUndefined();
	});

	test('a login is unique, and not empty', async () => {
		const { store } = await setup(create);
		await rejects(store.createAccount('Mary@Example.net'), 'ALREADY_EXISTS');
		await rejects(store.createAccount('  '), 'INVALID');
		expect((await store.createAccount(' john@example.net ')).name).toBe(
			'john@example.net',
		);
	});

	test('deleting one deletes its mailboxes, children first or not', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		await store.createMailbox(account.id, { name: 'B', parentId: a.id });
		await store.deleteMailbox(
			account.id,
			(await store.createMailbox(account.id, { name: 'C' })).id,
		);
		await store.deleteAccount(account.id);
		expect(await store.getAccount(account.id)).toBeUndefined();
		await rejects(store.getMailbox(account.id, inbox.id), 'NOT_FOUND');
		await rejects(store.deleteAccount(account.id), 'NOT_FOUND');
		const again = await store.createAccount('mary@example.net');
		expect(await store.listMailboxes(again.id)).toEqual([]);
		expect(await store.mailboxChanges(again.id, 0)).toMatchObject({
			modseq: 0,
			destroyed: [],
		});
	});

	test('a method given an unknown account is NOT_FOUND', async () => {
		const { store } = await setup(create);
		await rejects(store.listMailboxes('nope'), 'NOT_FOUND');
		await rejects(store.findMailbox('nope', 'inbox'), 'NOT_FOUND');
		await rejects(store.createMailbox('nope', { name: 'A' }), 'NOT_FOUND');
		await rejects(store.mailboxChanges('nope', 0), 'NOT_FOUND');
		await rejects(store.getMailbox('nope', 'x'), 'NOT_FOUND');
	});
});

describe('SqliteMailStore: mailboxes', () => {
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
		await rejects(store.findMailbox(account.id, undefined as never), 'INVALID');
		expect((await store.listMailboxes(account.id)).map((m) => m.name)).toEqual([
			'INBOX',
			'Sent',
		]);
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
		await rejects(store.createMailbox(account.id, null as never), 'INVALID');
	});
});

describe('SqliteMailStore: subscriptions and other accounts', () => {
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
		const same = await store.setSubscribed(account.id, lists.id, true);
		expect(same.highestModseq).toBe(lists.highestModseq);
		await rejects(store.setSubscribed(account.id, 'nope', true), 'NOT_FOUND');
		await rejects(
			store.setSubscribed(account.id, lists.id, 'yes' as never),
			'INVALID',
		);
		await rejects(
			store.createMailbox(account.id, { name: 'Y', isSubscribed: 1 as never }),
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
		expect(await store.getMailbox(other.id, theirs.id)).toMatchObject({
			name: 'Theirs',
			isSubscribed: true,
		});
	});
});

describe('SqliteMailStore: mailbox names and deletion', () => {
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
		expect((await store.createMailbox(account.id, { name: 'work' })).name).toBe(
			'work',
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

	test('one with children is never deleted', async () => {
		const { store, account } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const b = await store.createMailbox(account.id, {
			name: 'B',
			parentId: a.id,
		});
		await rejects(store.deleteMailbox(account.id, a.id), 'INVALID');
		await store.deleteMailbox(account.id, b.id, { removeMessages: true });
		await store.deleteMailbox(account.id, a.id);
		await rejects(store.deleteMailbox(account.id, a.id), 'NOT_FOUND');
		expect(await store.getMailbox(account.id, a.id)).toBeUndefined();
	});
});
