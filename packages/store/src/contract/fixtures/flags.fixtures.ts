import { describe, expect, test } from 'bun:test';
import { bytes, type CreateStore, rejects, setup } from './setup.fixtures';

export function describeFlags(create: CreateStore): void {
	describe('flags', () => {
		naming(create);
		changing(create);
		conditional(create);
		sharing(create);
	});
}

function naming(create: CreateStore): void {
	test('a system flag takes its canonical case, a keyword the case it was first stored with', async () => {
		const { store, account, inbox } = await setup(create);
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
			flags: ['\\FLAGGED', '$Junk', '$junk', 'NonJunk', '$MDNSent'],
		});
		expect(message.flags).toEqual([
			'$Junk',
			'$MDNSent',
			'\\Flagged',
			'NonJunk',
		]);
		expect((await store.getMessage(account.id, message.id))?.flags).toEqual(
			message.flags,
		);
	});

	test('RFC 9051 §2.3.2: keywords compare without case, and keep the case first stored', async () => {
		const { store, account, inbox } = await setup(create);
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
			flags: ['$Forwarded'],
		});
		// The same keyword in another case is the same keyword: no change, no modseq.
		const { messages: [same] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{ add: ['$FORWARDED', '$forwarded'] },
		);
		expect(same?.flags).toEqual(['$Forwarded']);
		expect(same?.modseq).toBe(message.modseq);
		const { messages: [reset] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{ set: ['$forwarded', '$NotJunk', '$notjunk'] },
		);
		expect(reset?.flags).toEqual(['$Forwarded', '$NotJunk']);
		const { messages: [removed] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{ remove: ['$NOTJUNK'] },
		);
		expect(removed?.flags).toEqual(['$Forwarded']);
		const { messages: [added] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{ add: ['Junk', '\\seen'] },
		);
		expect(added?.flags).toEqual(['$Forwarded', '\\Seen', 'Junk']);
		expect((await store.getMessage(account.id, message.id))?.flags).toEqual(
			added?.flags,
		);
	});

	test('RFC 8621 §4.1.1: a keyword is printable ASCII, 255 characters at most, no atom-special', async () => {
		const { store, account, inbox } = await setup(create);
		for (const flag of [
			'é',
			'a b',
			'a(',
			'a"',
			'a]',
			'%x',
			'\\Recent',
			'\\Custom',
			'',
			'x'.repeat(256),
		]) {
			await rejects(
				store.addMessage(account.id, inbox.id, {
					content: bytes('x'),
					flags: [flag],
				}),
				'INVALID',
			);
		}
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
			flags: ['k'.repeat(255)],
		});
		expect(message.flags).toEqual(['k'.repeat(255)]);
	});
}

function changing(create: CreateStore): void {
	test('change by set, add and remove, each change a new modseq', async () => {
		const { store, account, inbox } = await setup(create);
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
			flags: ['\\Seen'],
		});
		const { messages: [added] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{
				add: ['\\Flagged'],
			},
		);
		expect(added?.flags).toEqual(['\\Flagged', '\\Seen']);
		expect(added?.modseq).toBeGreaterThan(message.modseq);
		const { messages: [same] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{
				add: ['\\Seen'],
			},
		);
		expect(same?.modseq).toBe(added?.modseq);
		const { messages: [set] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{
				set: ['$Label'],
				add: ['\\Draft'],
				remove: ['$label'],
			},
		);
		expect(set?.flags).toEqual(['\\Draft']);
		expect((await store.getMailbox(account.id, inbox.id))?.highestModseq).toBe(
			set?.modseq,
		);
	});

	test('an id listed twice changes once; an unknown one is skipped and named', async () => {
		const { store, account, inbox } = await setup(create);
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
		});
		const result = await store.setFlags(
			account.id,
			[message.id, 'gone', message.id],
			{
				add: ['\\Flagged'],
			},
		);
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0]?.modseq).toBe(message.modseq + 1);
		expect(result.notFound).toEqual(['gone']);
	});
}

function conditional(create: CreateStore): void {
	test('RFC 7162 §3.1.3: UNCHANGEDSINCE leaves a message changed since alone, and names it', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.addMessage(account.id, inbox.id, {
			content: bytes('a'),
		});
		const b = await store.addMessage(account.id, inbox.id, {
			content: bytes('b'),
		});
		const result = await store.setFlags(
			account.id,
			[a.id, b.id],
			{ add: ['\\Deleted'] },
			{ unchangedSince: a.modseq },
		);
		expect(result.modified).toEqual([b.id]);
		expect(result.messages.map((m) => m.id)).toEqual([a.id]);
		expect((await store.getMessage(account.id, b.id))?.flags).toEqual([]);
		await rejects(
			store.setFlags(
				account.id,
				[a.id],
				{ add: ['\\Seen'] },
				{ unchangedSince: -1 },
			),
			'INVALID',
		);
	});
}

function sharing(create: CreateStore): void {
	test('flags belong to the message, in every mailbox it is in', async () => {
		const { store, account, inbox } = await setup(create);
		const a = await store.createMailbox(account.id, { name: 'A' });
		const message = await store.addMessage(account.id, inbox.id, {
			content: bytes('x'),
		});
		await store.linkMessages(account.id, [message.id], a.id);
		const { messages: [seen] = [] } = await store.setFlags(
			account.id,
			[message.id],
			{
				add: ['\\Seen'],
			},
		);
		expect(await store.getMailbox(account.id, a.id)).toMatchObject({
			unseen: 0,
			highestModseq: seen?.modseq,
		});
		expect(await store.getMailbox(account.id, inbox.id)).toMatchObject({
			unseen: 0,
			highestModseq: seen?.modseq,
		});
	});
}
