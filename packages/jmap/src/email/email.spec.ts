import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
	STORES,
} from '../server/app.fixtures';

describe.each(STORES)('Email on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8621 §4.1: metadata, header and body properties of a multipart email', async () => {
		h = await harness(kind);
		const message = await h.add(MULTIPART, h.inbox.id, [
			'\\Seen',
			'\\Deleted',
			'work',
		]);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			fetchTextBodyValues: true,
		});
		const [email] = args.list;
		expect(email).toMatchObject({
			id: message.id,
			blobId: message.blobId,
			threadId: message.threadId,
			mailboxIds: { [h.inbox.id]: true },
			keywords: { $seen: true, work: true },
			size: message.size,
			subject: 'Re: Report attached',
			from: [{ name: 'René', email: 'rene@example.com' }],
			inReplyTo: ['1234@local.machine.example'],
			messageId: null,
			sentAt: '2027-02-02T10:00:00Z',
			hasAttachment: true,
			preview: 'See the report.',
		});
		expect(email.textBody.map((p: { partId: string }) => p.partId)).toEqual([
			'1.1',
		]);
		expect(email.htmlBody.map((p: { partId: string }) => p.partId)).toEqual([
			'1.2',
		]);
		expect(email.attachments[0]).toMatchObject({
			partId: '2',
			name: 'report.pdf',
			type: 'application/pdf',
			size: 9,
			disposition: 'attachment',
		});
		expect(email.bodyValues).toEqual({
			'1.1': {
				value: 'See the report.',
				isEncodingProblem: false,
				isTruncated: false,
			},
		});
	});

	test('RFC 8621 §4.1.2: header: forms, :all, and bodyStructure', async () => {
		h = await harness(kind);
		const message = await h.add(MULTIPART);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: [
				'header:Subject',
				'header:Subject:asText',
				'header:To:asGroupedAddresses',
				'header:X-None:all',
				'bodyStructure',
			],
			bodyProperties: ['type', 'partId'],
		});
		const [email] = args.list;
		expect(email['header:Subject']).toBe('Re: Report attached');
		expect(email['header:To:asGroupedAddresses']).toEqual([
			{ name: null, addresses: [{ name: null, email: 'alice@example.com' }] },
			{ name: 'Team', addresses: [{ name: null, email: 'bob@example.com' }] },
		]);
		expect(email['header:X-None:all']).toEqual([]);
		expect(email.bodyStructure.type).toBe('multipart/mixed');
		expect(email.bodyStructure.subParts[0].subParts[1]).toEqual({
			type: 'text/html',
			partId: '1.2',
			subParts: null,
		});
		const bad = await h.call('Email/get', {
			ids: [message.id],
			properties: ['header:Bad Name'],
		});
		expect(bad.args.type).toBe('invalidArguments');
	});

	test('maxBodyValueBytes truncates a value on a character boundary', async () => {
		h = await harness(kind);
		const message = await h.add(SIMPLE);
		const { args } = await h.call('Email/get', {
			ids: [message.id],
			properties: ['bodyValues'],
			fetchAllBodyValues: true,
			maxBodyValueBytes: 10,
		});
		expect(args.list[0].bodyValues['1']).toEqual({
			value: 'This is a ',
			isEncodingProblem: false,
			isTruncated: true,
		});
	});

	test('RFC 8620 §3.7: the query, the threads and the emails in one request', async () => {
		h = await harness(kind);
		const old = await h.add(
			SIMPLE,
			h.inbox.id,
			[],
			new Date('2020-01-01T00:00:00Z'),
		);
		const recent = await h.add(
			MULTIPART,
			h.inbox.id,
			[],
			new Date('2021-01-01T00:00:00Z'),
		);
		const a = h.alice.id;
		const { methodResponses } = await h.api([
			[
				'Email/query',
				{
					accountId: a,
					filter: { inMailbox: h.inbox.id },
					sort: [{ property: 'receivedAt', isAscending: false }],
					collapseThreads: true,
					position: 0,
					limit: 10,
					calculateTotal: true,
				},
				't0',
			],
			[
				'Email/get',
				{
					accountId: a,
					'#ids': { resultOf: 't0', name: 'Email/query', path: '/ids' },
					properties: ['threadId'],
				},
				't1',
			],
			[
				'Thread/get',
				{
					accountId: a,
					'#ids': {
						resultOf: 't1',
						name: 'Email/get',
						path: '/list/*/threadId',
					},
				},
				't2',
			],
			[
				'Email/get',
				{
					accountId: a,
					'#ids': {
						resultOf: 't2',
						name: 'Thread/get',
						path: '/list/*/emailIds',
					},
					properties: ['from', 'receivedAt', 'subject'],
				},
				't3',
			],
		]);
		expect(methodResponses.map(([name]) => name)).toEqual([
			'Email/query',
			'Email/get',
			'Thread/get',
			'Email/get',
		]);
		expect(methodResponses[0]?.[1].ids).toEqual([recent.id, old.id]);
		expect(methodResponses[2]?.[1].list).toEqual([
			{ id: recent.threadId, emailIds: [recent.id] },
			{ id: old.threadId, emailIds: [old.id] },
		]);
		expect(methodResponses[3]?.[1].list[1]).toEqual({
			id: old.id,
			from: [{ name: 'John Doe', email: 'jdoe@machine.example' }],
			receivedAt: '2020-01-01T00:00:00Z',
			subject: 'Saying Hello',
		});
	});

	test('Email/query: keywords, dates, sizes, text, operators, sorts and paging', async () => {
		h = await harness(kind);
		const hello = await h.add(
			SIMPLE,
			h.inbox.id,
			['\\Flagged'],
			new Date('2020-01-01T00:00:00Z'),
		);
		const report = await h.add(
			MULTIPART,
			h.archive.id,
			[],
			new Date('2021-01-01T00:00:00Z'),
		);
		const ids = async (args: Record<string, unknown>) =>
			(await h.call('Email/query', args)).args.ids;
		expect(await ids({ filter: { hasKeyword: '$flagged' } })).toEqual([
			hello.id,
		]);
		expect(await ids({ filter: { notKeyword: '$flagged' } })).toEqual([
			report.id,
		]);
		expect(await ids({ filter: { inMailboxOtherThan: [h.inbox.id] } })).toEqual(
			[report.id],
		);
		expect(await ids({ filter: { before: '2020-06-01T00:00:00Z' } })).toEqual([
			hello.id,
		]);
		expect(await ids({ filter: { after: '2020-06-01T00:00:00Z' } })).toEqual([
			report.id,
		]);
		const [small, large] =
			hello.size < report.size ? [hello, report] : [report, hello];
		expect(await ids({ filter: { minSize: large.size } })).toEqual([large.id]);
		expect(await ids({ filter: { maxSize: large.size } })).toEqual([small.id]);
		expect(await ids({ filter: { from: 'rené' } })).toEqual([report.id]);
		expect(await ids({ filter: { to: 'mary' } })).toEqual([hello.id]);
		expect(await ids({ filter: { subject: 'hello' } })).toEqual([hello.id]);
		expect(await ids({ filter: { text: 'REPORT' } })).toEqual([report.id]);
		expect(await ids({ filter: { body: 'just to say' } })).toEqual([hello.id]);
		expect(
			await ids({
				filter: { operator: 'NOT', conditions: [{ text: 'report' }] },
			}),
		).toEqual([hello.id]);
		expect(
			await ids({
				filter: {
					operator: 'OR',
					conditions: [{ subject: 'hello' }, { subject: 'report' }],
				},
				sort: [{ property: 'subject' }],
			}),
		).toEqual([report.id, hello.id]);
		expect(await ids({ sort: [{ property: 'from' }] })).toEqual([
			hello.id,
			report.id,
		]);
		expect(
			await ids({ sort: [{ property: 'size', isAscending: true }] }),
		).toEqual([small.id, large.id]);
		const page = await h.call('Email/query', {
			position: -1,
			calculateTotal: true,
		});
		expect(page.args).toMatchObject({ position: 1, ids: [hello.id], total: 2 });
		const anchored = await h.call('Email/query', {
			anchor: report.id,
			anchorOffset: 1,
		});
		expect(anchored.args.ids).toEqual([hello.id]);
		expect((await h.call('Email/query', { anchor: 'nope' })).args.type).toBe(
			'anchorNotFound',
		);
		expect(
			(await h.call('Email/query', { filter: { header: ['X'] } })).args.type,
		).toBe('unsupportedFilter');
		expect(
			(await h.call('Email/query', { sort: [{ property: 'hasKeyword' }] })).args
				.type,
		).toBe('unsupportedSort');
	});

	test('RFC 8621 §4.6: Email/set updates keywords and mailboxIds, whole or patched, and destroys', async () => {
		h = await harness(kind);
		const message = await h.add(SIMPLE, h.inbox.id, ['\\Deleted']);
		const { args } = await h.call('Email/set', {
			update: {
				[message.id]: {
					'keywords/$seen': true,
					'keywords/$flagged': true,
					[`mailboxIds/${h.archive.id}`]: true,
					[`mailboxIds/${h.inbox.id}`]: null,
				},
			},
		});
		expect(args.updated).toEqual({ [message.id]: null });
		let stored = await h.store.getMessage(h.alice.id, message.id);
		expect(stored?.flags).toEqual(['\\Deleted', '\\Flagged', '\\Seen']);
		expect(stored?.mailboxes.map((m) => m.mailboxId)).toEqual([h.archive.id]);
		await h.call('Email/set', {
			update: {
				[message.id]: {
					keywords: { $answered: true },
					mailboxIds: { [h.inbox.id]: true, [h.archive.id]: true },
				},
			},
		});
		stored = await h.store.getMessage(h.alice.id, message.id);
		expect(stored?.flags).toEqual(['\\Answered', '\\Deleted']);
		expect(stored?.mailboxes).toHaveLength(2);
		const refused = await h.call('Email/set', {
			update: { [message.id]: { mailboxIds: {} }, nope: { keywords: {} } },
			destroy: ['gone'],
		});
		expect(refused.args.notUpdated[message.id].type).toBe('invalidProperties');
		expect(refused.args.notUpdated.nope.type).toBe('notFound');
		expect(refused.args.notDestroyed.gone.type).toBe('notFound');
		const mixed = await h.call('Email/set', {
			update: { [message.id]: { keywords: {}, 'keywords/$seen': true } },
		});
		expect(mixed.args.notUpdated[message.id].type).toBe('invalidPatch');
		const destroyed = await h.call('Email/set', { destroy: [message.id] });
		expect(destroyed.args.destroyed).toEqual([message.id]);
		expect(await h.store.getMessage(h.alice.id, message.id)).toBeUndefined();
	});

	test('Email/changes lists created, updated and destroyed emails', async () => {
		h = await harness(kind);
		const kept = await h.add(SIMPLE);
		const gone = await h.add(MULTIPART);
		const since = (await h.call('Email/get', { ids: [] })).args.state;
		const fresh = await h.add(SIMPLE);
		await h.store.setFlags(h.alice.id, [kept.id], { add: ['\\Seen'] });
		await h.store.destroyMessages(h.alice.id, [gone.id]);
		const { args } = await h.call('Email/changes', { sinceState: since });
		expect(args).toMatchObject({
			oldState: since,
			created: [fresh.id],
			updated: [kept.id],
			destroyed: [gone.id],
			hasMoreChanges: false,
		});
		expect(Number(args.newState)).toBeGreaterThan(Number(since));
	});
});
