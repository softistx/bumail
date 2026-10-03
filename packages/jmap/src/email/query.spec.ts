import { afterEach, describe, expect, test } from 'bun:test';
import {
	type Harness,
	harness,
	MULTIPART,
	SIMPLE,
	STORES,
} from '../server/app.fixtures';

/** RFC 8620 §3.7's example: a query, its emails' threads, and the threads' emails. */
const section37 = (a: string, inbox: string): unknown[] => [
	[
		'Email/query',
		{
			accountId: a,
			filter: { inMailbox: inbox },
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
];

describe.each(STORES)('Email/query on the %s store', (kind) => {
	let h: Harness;
	afterEach(() => h.close());

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
		const { methodResponses } = await h.api(section37(h.alice.id, h.inbox.id));
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

	test('Email/query: mailbox, keyword, date, size and text conditions, and operators', async () => {
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
	});

	test('Email/query: sorts, positions and anchors', async () => {
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
		const [small, large] =
			hello.size < report.size ? [hello, report] : [report, hello];
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
});
