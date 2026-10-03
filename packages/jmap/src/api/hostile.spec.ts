import { afterEach, describe, expect, test } from 'bun:test';
import {
	CORE,
	type Harness,
	harness,
	MAIL,
	SIMPLE,
} from '../server/app.fixtures';

type Problem = { type: string; status: number; limit?: string; detail: string };

const body = (methodCalls: unknown[]) =>
	JSON.stringify({ using: [CORE, MAIL], methodCalls });

describe('hostile method calls', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('a back-reference expands to at most maxReferenceItems values', async () => {
		h = await harness('memory', { limits: { maxReferenceItems: 3 } });
		const { methodResponses } = await h.api([
			['Core/echo', { ids: ['a', 'b', 'c', 'd'] }, 'e'],
			[
				'Email/get',
				{
					accountId: h.alice.id,
					'#ids': { resultOf: 'e', name: 'Core/echo', path: '/ids' },
				},
				'g',
			],
		]);
		expect(methodResponses[1]?.[1]).toMatchObject({
			type: 'invalidResultReference',
		});
	});

	test('ids are [A-Za-z0-9_-]{1,255}; anything else is invalidArguments', async () => {
		h = await harness();
		for (const id of ['a b', 'é', '', 'x'.repeat(256), '../etc']) {
			expect((await h.call('Email/get', { ids: [id] })).args.type).toBe(
				'invalidArguments',
			);
		}
		const download = await h.fetch(`/jmap/download/${h.alice.id}/..%2Fetc/x`);
		expect(download.status).toBe(404);
	});

	test("an account never names another account's data", async () => {
		h = await harness();
		const bobs = await h.store.addMessage(h.bob.id, h.bobInbox.id, {
			content: new TextEncoder().encode(SIMPLE),
		});
		expect(
			(await h.call('Email/get', { ids: [bobs.id] })).args.notFound,
		).toEqual([bobs.id]);
		expect(
			(await h.call('Mailbox/get', { ids: [h.bobInbox.id] })).args.notFound,
		).toEqual([h.bobInbox.id]);
		expect(
			(await h.call('Thread/get', { ids: [bobs.threadId] })).args.notFound,
		).toEqual([bobs.threadId]);
		const set = await h.call('Email/set', {
			update: { [bobs.id]: { keywords: {} } },
			destroy: [bobs.id],
		});
		expect(set.args.notUpdated[bobs.id].type).toBe('notFound');
		expect(set.args.notDestroyed[bobs.id].type).toBe('notFound');
		const mine = await h.add(SIMPLE);
		const moved = await h.call('Email/set', {
			update: { [mine.id]: { mailboxIds: { [h.bobInbox.id]: true } } },
		});
		expect(moved.args.notUpdated[mine.id].type).toBe('invalidProperties');
		expect(
			(await h.call('Mailbox/set', { destroy: [h.bobInbox.id] })).args
				.notDestroyed[h.bobInbox.id].type,
		).toBe('notFound');
		expect((await h.store.getMessage(h.bob.id, bobs.id))?.flags).toEqual([]);
	});

	test('client text is never echoed unbounded', async () => {
		h = await harness();
		const long = 'x'.repeat(10_000);
		const capability = await h.fetch('/jmap/api', {
			method: 'POST',
			body: JSON.stringify({ using: [long.slice(0, 200)], methodCalls: [] }),
		});
		expect(((await capability.json()) as Problem).detail.length).toBeLessThan(
			200,
		);
		const argument = await h.call('Mailbox/get', { [long]: 1 });
		expect(argument.args.description.length).toBeLessThan(200);
		const callId = await h.fetch('/jmap/api', {
			method: 'POST',
			body: body([['Core/echo', {}, long]]),
		});
		expect(((await callId.json()) as Problem).type).toBe(
			'urn:ietf:params:jmap:error:notRequest',
		);
		const auth = await h.fetch('/.well-known/jmap', {
			headers: { authorization: `Bearer ${long}` },
		});
		expect(auth.status).toBe(401);
	});

	test('maxQueryScan bounds a query and a thread lookup', async () => {
		h = await harness('memory', { limits: { maxQueryScan: 1 } });
		const one = await h.add(SIMPLE);
		await h.add(SIMPLE);
		expect((await h.call('Email/query', {})).args.type).toBe('tooLarge');
		expect(
			(await h.call('Thread/get', { ids: [one.threadId] })).args.type,
		).toBe('tooLarge');
	});

	test('maxBodyValuesTotal bounds the body values of one request', async () => {
		h = await harness('memory', { limits: { maxBodyValuesTotal: 10 } });
		const one = await h.add(SIMPLE);
		const two = await h.add(SIMPLE);
		const { args } = await h.call('Email/get', {
			ids: [one.id, two.id],
			properties: ['bodyValues'],
			fetchTextBodyValues: true,
		});
		expect(args.list[0].bodyValues['1']).toMatchObject({
			value: 'This is a ',
			isTruncated: true,
		});
		expect(args.list[1].bodyValues['1']).toMatchObject({
			value: '',
			isTruncated: true,
		});
	});
});
