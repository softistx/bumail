import { describe, expect, test } from 'bun:test';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeChangesFilter(create: CreateStore): void {
	describe('changes of one mailbox', () => {
		movedInAndOut(create);
		leftAndBack(create);
		elsewhere(create);
		fromZero(create);
		refusals(create);
	});
}

function movedInAndOut(create: CreateStore): void {
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
		expect(await changes(inbox.id)).toMatchObject({
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
}

function leftAndBack(create: CreateStore): void {
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
}

function elsewhere(create: CreateStore): void {
	test('a change in another mailbox updates the message; destroying it destroys it in each', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const linked = await store.addMessage(account.id, inbox.id, {
			content: bytes('linked'),
		});
		const both = await store.addMessage(account.id, inbox.id, {
			content: bytes('both'),
		});
		await store.linkMessages(account.id, [both.id], a.id);
		const { modseq } = await store.messageChanges(account.id, 0);
		await store.linkMessages(account.id, [linked.id], a.id);
		await store.destroyMessages(account.id, [both.id]);
		const changes = (mailboxId: string) =>
			store.messageChanges(account.id, modseq, { mailboxId });
		// Its mailboxes are part of the message: a link elsewhere is a change.
		expect(await changes(inbox.id)).toMatchObject({
			created: [],
			updated: [linked.id],
			destroyed: [both.id],
			expunged: [{ messageId: both.id, mailboxId: inbox.id }],
		});
		expect(await changes(a.id)).toMatchObject({
			created: [linked.id],
			updated: [],
			destroyed: [both.id],
			expunged: [{ messageId: both.id, mailboxId: a.id }],
		});
	});
}

function fromZero(create: CreateStore): void {
	test('since 0, or since before the mailbox was made, the mailbox is its whole state', async () => {
		const { store, account, inbox } = await setup(create);
		const { modseq } = await store.messageChanges(account.id, 0);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const mine = await store.addMessage(account.id, inbox.id, {
			content: bytes('mine'),
		});
		const theirs = await store.addMessage(account.id, a.id, {
			content: bytes('other'),
		});
		expect(
			await store.messageChanges(account.id, 0, { mailboxId: inbox.id }),
		).toMatchObject({
			created: [mine.id],
			updated: [],
			destroyed: [],
			expunged: [],
		});
		expect(
			await store.messageChanges(account.id, modseq, { mailboxId: a.id }),
		).toMatchObject({ created: [theirs.id], updated: [], destroyed: [] });
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
