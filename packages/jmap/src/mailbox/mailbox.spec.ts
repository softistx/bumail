import { afterEach, describe, expect, test } from 'bun:test';
import { type Harness, harness, SIMPLE, STORES } from '../server/app.fixtures';

describe.each(STORES)('Mailbox on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8621 §2.6: Mailbox/get with ids null lists every mailbox', async () => {
		h = await harness(kind);
		await h.add(SIMPLE);
		const { name, args } = await h.call('Mailbox/get', { ids: null });
		expect(name).toBe('Mailbox/get');
		expect(args.list.map((m: { name: string }) => m.name).sort()).toEqual([
			'Archive',
			'INBOX',
		]);
		const inbox = args.list.find((m: { role: string }) => m.role === 'inbox');
		expect(inbox).toMatchObject({
			totalEmails: 1,
			unreadEmails: 1,
			totalThreads: 1,
			unreadThreads: 1,
			parentId: null,
			sortOrder: 0,
			isSubscribed: true,
		});
		expect(inbox.myRights.maySubmit).toBe(false);
		expect(args.notFound).toEqual([]);
	});

	test('Mailbox/get answers only the properties asked, id always, and notFound', async () => {
		h = await harness(kind);
		const { args } = await h.call('Mailbox/get', {
			ids: [h.inbox.id, 'nope'],
			properties: ['name'],
		});
		expect(args.list).toEqual([{ id: h.inbox.id, name: 'INBOX' }]);
		expect(args.notFound).toEqual(['nope']);
		const bad = await h.call('Mailbox/get', { properties: ['colour'] });
		expect(bad.args.type).toBe('invalidArguments');
	});

	test('Mailbox/set creates, renames, moves, subscribes and destroys', async () => {
		h = await harness(kind);
		const created = await h.call('Mailbox/set', {
			create: {
				a: { name: 'Projects' },
				b: { name: 'Bumail', parentId: '#a', isSubscribed: false },
			},
		});
		const projects = created.args.created.a.id;
		const bumail = created.args.created.b.id;
		expect(created.args.created.b).toMatchObject({
			totalEmails: 0,
			isSubscribed: false,
		});
		const updated = await h.call('Mailbox/set', {
			update: {
				[bumail]: { name: 'JMAP', parentId: null, isSubscribed: true },
			},
		});
		expect(updated.args.updated).toEqual({ [bumail]: null });
		const mailbox = await h.store.getMailbox(h.alice.id, bumail);
		expect(mailbox).toMatchObject({ name: 'JMAP', isSubscribed: true });
		expect(mailbox?.parentId).toBeUndefined();
		const destroyed = await h.call('Mailbox/set', {
			destroy: [projects, bumail],
		});
		expect(destroyed.args.destroyed).toEqual([projects, bumail]);
		expect(Number(destroyed.args.newState)).toBeGreaterThan(
			Number(destroyed.args.oldState),
		);
	});

	test('RFC 8621 §2.6: destroying a mailbox that holds email is mailboxHasEmail without onDestroyRemoveEmails', async () => {
		h = await harness(kind);
		await h.add(SIMPLE, h.archive.id);
		const refused = await h.call('Mailbox/set', { destroy: [h.archive.id] });
		expect(refused.args.notDestroyed[h.archive.id].type).toBe(
			'mailboxHasEmail',
		);
		const done = await h.call('Mailbox/set', {
			destroy: [h.archive.id],
			onDestroyRemoveEmails: true,
		});
		expect(done.args.destroyed).toEqual([h.archive.id]);
	});

	test('a mailbox with a child is mailboxHasChild; a property the store cannot keep is invalidProperties', async () => {
		h = await harness(kind);
		await h.store.createMailbox(h.alice.id, {
			name: 'Child',
			parentId: h.archive.id,
		});
		const { args } = await h.call('Mailbox/set', {
			destroy: [h.archive.id],
			update: { [h.inbox.id]: { sortOrder: 5 } },
			create: { x: { name: 'X', totalEmails: 3 }, y: { name: 'INBOX' } },
		});
		expect(args.notDestroyed[h.archive.id].type).toBe('mailboxHasChild');
		expect(args.notUpdated[h.inbox.id]).toMatchObject({
			type: 'invalidProperties',
			properties: ['sortOrder'],
		});
		expect(args.notCreated.x.properties).toEqual(['totalEmails']);
		expect(args.notCreated.y.type).toBe('invalidProperties');
	});

	test('ifInState: a stale state is stateMismatch', async () => {
		h = await harness(kind);
		const { args } = await h.call('Mailbox/get', { ids: [] });
		await h.store.createMailbox(h.alice.id, { name: 'Elsewhere' });
		const stale = await h.call('Mailbox/set', {
			ifInState: args.state,
			create: { a: { name: 'A' } },
		});
		expect(stale.args.type).toBe('stateMismatch');
	});

	test('Mailbox/changes lists what changed since a state', async () => {
		h = await harness(kind);
		const before = (await h.call('Mailbox/get', { ids: [] })).args.state;
		const made = await h.store.createMailbox(h.alice.id, { name: 'New' });
		await h.store.renameMailbox(h.alice.id, h.archive.id, { name: 'Old' });
		const { args } = await h.call('Mailbox/changes', { sinceState: before });
		expect(args).toMatchObject({
			oldState: before,
			created: [made.id],
			updated: [h.archive.id],
			destroyed: [],
			hasMoreChanges: false,
			updatedProperties: null,
		});
		const paged = await h.call('Mailbox/changes', {
			sinceState: before,
			maxChanges: 1,
		});
		expect(paged.args.hasMoreChanges).toBe(true);
		const bad = await h.call('Mailbox/changes', { sinceState: '999999' });
		expect(bad.args.type).toBe('cannotCalculateChanges');
		const junk = await h.call('Mailbox/changes', { sinceState: 'abc' });
		expect(junk.args.type).toBe('cannotCalculateChanges');
	});

	test('Mailbox/query filters by parentId, role and name, and sorts by sortOrder then name', async () => {
		h = await harness(kind);
		const child = await h.store.createMailbox(h.alice.id, {
			name: 'Zeta',
			parentId: h.archive.id,
		});
		const top = await h.call('Mailbox/query', {
			filter: { parentId: null },
			sort: [{ property: 'sortOrder' }, { property: 'name' }],
		});
		expect(top.args.ids).toEqual([h.archive.id, h.inbox.id]);
		expect(
			(await h.call('Mailbox/query', { filter: { parentId: h.archive.id } }))
				.args.ids,
		).toEqual([child.id]);
		expect(
			(await h.call('Mailbox/query', { filter: { role: 'inbox' } })).args.ids,
		).toEqual([h.inbox.id]);
		expect(
			(await h.call('Mailbox/query', { filter: { name: 'zet' } })).args.ids,
		).toEqual([child.id]);
		const either = await h.call('Mailbox/query', {
			filter: {
				operator: 'OR',
				conditions: [{ role: 'inbox' }, { name: 'Zeta' }],
			},
			sort: [{ property: 'name', isAscending: false }],
			calculateTotal: true,
		});
		expect(either.args).toMatchObject({
			ids: [child.id, h.inbox.id],
			total: 2,
			position: 0,
			canCalculateChanges: false,
		});
		const bad = await h.call('Mailbox/query', {
			sort: [{ property: 'totalEmails' }],
		});
		expect(bad.args.type).toBe('unsupportedSort');
		const badFilter = await h.call('Mailbox/query', {
			filter: { colour: 'red' },
		});
		expect(badFilter.args.type).toBe('unsupportedFilter');
	});
});
