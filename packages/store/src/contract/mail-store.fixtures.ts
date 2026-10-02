import { describe, expect, test } from 'bun:test';
import type { MailStore } from './types';

const bytes = (text: string) => new TextEncoder().encode(text);

/**
 * The specs every `MailStore` must pass. Each store's own spec calls this
 * with a factory, so the memory store and every other answer to the
 * contract are held to the same behaviour.
 */
export function describeMailStore(
	name: string,
	create: () => Promise<MailStore> | MailStore,
): void {
	describe(`${name}: the MailStore contract`, () => {
		const setup = async () => {
			const store = await create();
			const account = await store.createAccount('mary@example.net');
			const inbox = await store.createMailbox(account.id, {
				name: 'INBOX',
				role: 'inbox',
			});
			return { store, account, inbox };
		};

		describe('accounts', () => {
			test('are found by id and by login, case-insensitively', async () => {
				const { store, account } = await setup();
				expect(await store.getAccount(account.id)).toEqual(account);
				expect(await store.findAccount('MARY@example.NET')).toEqual(account);
				expect(await store.findAccount('nobody@example.net')).toBeUndefined();
			});

			test('a login is unique', async () => {
				const { store } = await setup();
				await expect(
					store.createAccount('Mary@Example.net'),
				).rejects.toMatchObject({
					code: 'ALREADY_EXISTS',
				});
				await expect(store.createAccount('  ')).rejects.toMatchObject({
					code: 'INVALID',
				});
			});

			test('deleting one deletes its mailboxes and messages', async () => {
				const { store, account, inbox } = await setup();
				const message = await store.addMessage(inbox.id, {
					content: bytes('x'),
				});
				await store.deleteAccount(account.id);
				expect(await store.getAccount(account.id)).toBeUndefined();
				expect(await store.getMailbox(inbox.id)).toBeUndefined();
				expect(await store.getMessage(message.id)).toBeUndefined();
				expect(await store.readContent(message.blobId)).toBeUndefined();
			});
		});

		describe('mailboxes', () => {
			test('start empty, with a UIDVALIDITY of their own', async () => {
				const { store, account, inbox } = await setup();
				const sent = await store.createMailbox(account.id, {
					name: 'Sent',
					role: 'sent',
				});
				expect(inbox).toMatchObject({
					name: 'INBOX',
					role: 'inbox',
					uidNext: 1,
					messages: 0,
					unseen: 0,
				});
				expect(sent.uidValidity).not.toBe(inbox.uidValidity);
				expect(await store.findMailbox(account.id, 'sent')).toEqual(sent);
				expect(
					(await store.listMailboxes(account.id)).map((m) => m.name).sort(),
				).toEqual(['INBOX', 'Sent']);
			});

			test('a name is unique under its parent, a role in its account', async () => {
				const { store, account, inbox } = await setup();
				await expect(
					store.createMailbox(account.id, { name: 'INBOX' }),
				).rejects.toMatchObject({
					code: 'ALREADY_EXISTS',
				});
				await expect(
					store.createMailbox(account.id, { name: 'Other', role: 'inbox' }),
				).rejects.toMatchObject({
					code: 'ALREADY_EXISTS',
				});
				const child = await store.createMailbox(account.id, {
					name: 'INBOX',
					parentId: inbox.id,
				});
				expect(child.parentId).toBe(inbox.id);
				await expect(
					store.createMailbox(account.id, { name: '' }),
				).rejects.toMatchObject({ code: 'INVALID' });
			});

			test('are renamed and moved, never inside themselves', async () => {
				const { store, account, inbox } = await setup();
				const work = await store.createMailbox(account.id, { name: 'Work' });
				const projects = await store.createMailbox(account.id, {
					name: 'Projects',
					parentId: work.id,
				});
				const renamed = await store.renameMailbox(work.id, 'Job', inbox.id);
				expect(renamed).toMatchObject({ name: 'Job', parentId: inbox.id });
				await expect(
					store.renameMailbox(work.id, 'Job', projects.id),
				).rejects.toMatchObject({ code: 'INVALID' });
				const top = await store.renameMailbox(work.id, 'Job');
				expect(top.parentId).toBeUndefined();
			});

			test('only an empty mailbox without children is deleted', async () => {
				const { store, account, inbox } = await setup();
				const parent = await store.createMailbox(account.id, {
					name: 'Parent',
				});
				await store.createMailbox(account.id, {
					name: 'Child',
					parentId: parent.id,
				});
				await expect(store.deleteMailbox(parent.id)).rejects.toMatchObject({
					code: 'INVALID',
				});
				await store.addMessage(inbox.id, { content: bytes('x') });
				await expect(store.deleteMailbox(inbox.id)).rejects.toMatchObject({
					code: 'INVALID',
				});
				const empty = await store.createMailbox(account.id, { name: 'Empty' });
				await store.deleteMailbox(empty.id);
				expect(await store.getMailbox(empty.id)).toBeUndefined();
			});

			test('an unknown id is NOT_FOUND', async () => {
				const { store } = await setup();
				await expect(store.listMessages('nope')).rejects.toMatchObject({
					code: 'NOT_FOUND',
				});
				await expect(
					store.createMailbox('nope', { name: 'x' }),
				).rejects.toMatchObject({ code: 'NOT_FOUND' });
				expect(await store.getMailbox('nope')).toBeUndefined();
			});
		});

		describe('messages', () => {
			test('get ascending UIDs and modseqs, and their content back', async () => {
				const { store, inbox } = await setup();
				const receivedAt = new Date('2026-10-02T22:00:00Z');
				const first = await store.addMessage(inbox.id, {
					content: bytes('Subject: one\r\n\r\n1'),
					receivedAt,
				});
				const second = await store.addMessage(inbox.id, {
					content: bytes('Subject: two\r\n\r\n2'),
					flags: ['\\seen', '$label'],
				});
				expect(first).toMatchObject({
					uid: 1,
					size: 17,
					flags: [],
					receivedAt,
				});
				expect(second.uid).toBe(2);
				expect(second.modseq).toBeGreaterThan(first.modseq);
				expect(second.flags).toEqual(['$label', '\\Seen']);
				expect(
					new TextDecoder().decode(await store.readContent(first.blobId)),
				).toBe('Subject: one\r\n\r\n1');
				expect(await store.getMailbox(inbox.id)).toMatchObject({
					uidNext: 3,
					messages: 2,
					unseen: 1,
					highestModseq: second.modseq,
				});
				expect((await store.listMessages(inbox.id)).map((m) => m.uid)).toEqual([
					1, 2,
				]);
				expect(
					(await store.listMessages(inbox.id, 2)).map((m) => m.uid),
				).toEqual([2]);
			});

			test('a UID is never reused, even after a removal', async () => {
				const { store, inbox } = await setup();
				const first = await store.addMessage(inbox.id, { content: bytes('a') });
				await store.removeMessages([first.id]);
				const next = await store.addMessage(inbox.id, { content: bytes('b') });
				expect(next.uid).toBe(2);
			});

			test('the blob id is the SHA-256 of the content', async () => {
				const { store, inbox } = await setup();
				const message = await store.addMessage(inbox.id, {
					content: bytes('abc'),
				});
				expect(message.blobId).toBe(
					'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
				);
			});

			test('a flag that is neither a system flag nor a keyword is INVALID', async () => {
				const { store, inbox } = await setup();
				await expect(
					store.addMessage(inbox.id, {
						content: bytes('x'),
						flags: ['\\Recent'],
					}),
				).rejects.toMatchObject({
					code: 'INVALID',
				});
				await expect(
					store.addMessage(inbox.id, {
						content: bytes('x'),
						flags: ['two words'],
					}),
				).rejects.toMatchObject({
					code: 'INVALID',
				});
			});

			test('flags change by set, add and remove, each change a new modseq', async () => {
				const { store, inbox } = await setup();
				const message = await store.addMessage(inbox.id, {
					content: bytes('x'),
					flags: ['\\Draft'],
				});
				const [seen] = await store.setFlags([message.id], {
					add: ['\\Seen', '\\Flagged'],
					remove: ['\\Draft'],
				});
				expect(seen?.flags).toEqual(['\\Flagged', '\\Seen']);
				expect(seen?.modseq).toBeGreaterThan(message.modseq);
				const [same] = await store.setFlags([message.id], { add: ['\\Seen'] });
				expect(same?.modseq).toBe(seen?.modseq);
				const [replaced] = await store.setFlags([message.id], {
					set: ['$Junk'],
				});
				expect(replaced?.flags).toEqual(['$Junk']);
				expect((await store.getMailbox(inbox.id))?.unseen).toBe(1);
			});

			test('copies share the blob, get new UIDs, and keep flags', async () => {
				const { store, account, inbox } = await setup();
				const archive = await store.createMailbox(account.id, {
					name: 'Archive',
					role: 'archive',
				});
				const message = await store.addMessage(inbox.id, {
					content: bytes('x'),
					flags: ['\\Seen'],
				});
				const [copy] = await store.copyMessages([message.id], archive.id);
				expect(copy).toMatchObject({
					mailboxId: archive.id,
					uid: 1,
					blobId: message.blobId,
					flags: ['\\Seen'],
				});
				await store.removeMessages([message.id]);
				expect(await store.readContent(message.blobId)).toBeDefined();
				await store.removeMessages([(copy as { id: string }).id]);
				expect(await store.readContent(message.blobId)).toBeUndefined();
			});

			test('a move is a copy and a removal', async () => {
				const { store, account, inbox } = await setup();
				const trash = await store.createMailbox(account.id, {
					name: 'Trash',
					role: 'trash',
				});
				const message = await store.addMessage(inbox.id, {
					content: bytes('x'),
				});
				const [moved] = await store.moveMessages([message.id], trash.id);
				expect(moved?.mailboxId).toBe(trash.id);
				expect(await store.getMessage(message.id)).toBeUndefined();
				expect(await store.listMessages(inbox.id)).toEqual([]);
			});

			test('messages never cross accounts', async () => {
				const { store, inbox } = await setup();
				const other = await store.createAccount('other@example.net');
				const theirs = await store.createMailbox(other.id, { name: 'INBOX' });
				const message = await store.addMessage(inbox.id, {
					content: bytes('x'),
				});
				await expect(
					store.copyMessages([message.id], theirs.id),
				).rejects.toMatchObject({ code: 'INVALID' });
				await expect(
					store.moveMessages([message.id], theirs.id),
				).rejects.toMatchObject({ code: 'INVALID' });
				expect(await store.getMessage(message.id)).toBeDefined();
			});
		});

		describe('changes', () => {
			test('what was added, changed and removed since a modseq', async () => {
				const { store, account, inbox } = await setup();
				const start = await store.changes(account.id, 0);
				const kept = await store.addMessage(inbox.id, { content: bytes('a') });
				const gone = await store.addMessage(inbox.id, { content: bytes('b') });
				const middle = await store.changes(account.id, start.modseq);
				expect(middle.messages.map((m) => m.id)).toEqual([kept.id, gone.id]);

				await store.setFlags([kept.id], { add: ['\\Seen'] });
				const [removed] = await store.removeMessages([gone.id]);
				const end = await store.changes(account.id, middle.modseq);
				expect(end.messages.map((m) => m.id)).toEqual([kept.id]);
				expect(end.removed).toEqual([
					{
						id: gone.id,
						mailboxId: inbox.id,
						uid: 2,
						modseq: (removed as { modseq: number }).modseq,
					},
				]);
				expect(end.modseq).toBeGreaterThan(middle.modseq);

				const nothing = await store.changes(account.id, end.modseq);
				expect(nothing).toEqual({
					modseq: end.modseq,
					messages: [],
					removed: [],
				});
			});

			test('accounts count their changes apart', async () => {
				const { store, account, inbox } = await setup();
				const other = await store.createAccount('other@example.net');
				const theirs = await store.createMailbox(other.id, { name: 'INBOX' });
				await store.addMessage(theirs.id, { content: bytes('x') });
				expect((await store.changes(account.id, 0)).messages).toEqual([]);
				await store.addMessage(inbox.id, { content: bytes('y') });
				expect((await store.changes(account.id, 0)).messages).toHaveLength(1);
			});
		});
	});
}
