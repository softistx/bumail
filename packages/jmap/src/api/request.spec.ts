import { afterEach, describe, expect, test } from 'bun:test';
import { CORE, type Harness, harness, MAIL } from '../server/app.fixtures';

const post = (h: Harness, body: string) =>
	h.fetch('/jmap/api', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body,
	});

describe('the request envelope', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('RFC 8620 §3.3.1: each call answered in order, by its call id', async () => {
		h = await harness();
		const { methodResponses } = await h.api([
			['method1', { arg1: 'arg1data', arg2: 'arg2data' }, 'c1'],
			['method2', { arg1: 'arg1data' }, 'c2'],
			['method3', {}, 'c3'],
		]);
		expect(methodResponses).toEqual([
			['error', { type: 'unknownMethod' }, 'c1'],
			['error', { type: 'unknownMethod' }, 'c2'],
			['error', { type: 'unknownMethod' }, 'c3'],
		]);
	});

	test('RFC 8620 §4.1: Core/echo answers its arguments', async () => {
		h = await harness();
		const { methodResponses } = await h.api(
			[['Core/echo', { hello: true, high: 5 }, 'b3ff']],
			{ using: [CORE] },
		);
		expect(methodResponses).toEqual([
			['Core/echo', { hello: true, high: 5 }, 'b3ff'],
		]);
	});

	test('RFC 8620 §3.6.1: notJSON, notRequest, unknownCapability, as problem details', async () => {
		h = await harness();
		const cases: [string, string][] = [
			['{"using": [', 'urn:ietf:params:jmap:error:notJSON'],
			['[]', 'urn:ietf:params:jmap:error:notRequest'],
			[
				'{"using":[],"methodCalls":[["Core/echo",{},1]]}',
				'urn:ietf:params:jmap:error:notRequest',
			],
			[
				'{"using":["https://example.com/apis/foobar"],"methodCalls":[]}',
				'urn:ietf:params:jmap:error:unknownCapability',
			],
		];
		for (const [body, type] of cases) {
			const response = await post(h, body);
			expect(response.status).toBe(400);
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
			expect(await response.json()).toMatchObject({ type, status: 400 });
		}
		const bytes = await h.fetch('/jmap/api', {
			method: 'POST',
			body: new Uint8Array([0x7b, 0xff, 0x7d]),
		});
		expect(((await bytes.json()) as { type: string }).type).toBe(
			'urn:ietf:params:jmap:error:notJSON',
		);
	});

	test('RFC 8620 §3.6.2: a method whose capability is not in using is unknownMethod', async () => {
		h = await harness();
		const { methodResponses } = await h.api(
			[['Mailbox/get', { accountId: h.alice.id }, '0']],
			{ using: [CORE] },
		);
		expect(methodResponses[0]?.[1]).toEqual({ type: 'unknownMethod' });
	});

	test('accountNotFound, invalidArguments, and createdIds given back', async () => {
		h = await harness();
		const { methodResponses, createdIds } = await h.api(
			[
				['Mailbox/get', { accountId: h.bob.id }, '0'],
				['Mailbox/get', {}, '1'],
				['Mailbox/get', { accountId: h.alice.id, colour: 'red' }, '2'],
				[
					'Mailbox/set',
					{ accountId: h.alice.id, create: { n: { name: 'New' } } },
					'3',
				],
			],
			{ createdIds: { earlier: 'abc' } },
		);
		expect(methodResponses[0]?.[1]).toEqual({ type: 'accountNotFound' });
		expect(methodResponses[1]?.[1]).toMatchObject({ type: 'invalidArguments' });
		expect(methodResponses[2]?.[1]).toEqual({
			type: 'invalidArguments',
			description: 'Unknown argument "colour"',
		});
		expect(createdIds).toEqual({
			earlier: 'abc',
			n: methodResponses[3]?.[1].created.n.id,
		});
	});

	test('a store that fails is serverFail, and onError is told which method', async () => {
		const errors: { error: unknown; method?: string }[] = [];
		h = await harness('memory', {
			onError: (error, context) =>
				errors.push({
					error,
					...(context.method ? { method: context.method } : {}),
				}),
		});
		h.store.listMailboxes = async () => {
			throw new Error('disk on fire');
		};
		const { methodResponses } = await h.api(
			[['Mailbox/get', { accountId: h.alice.id }, '0']],
			{ using: [CORE, MAIL] },
		);
		expect(methodResponses[0]?.[1]).toEqual({ type: 'serverFail' });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.method).toBe('Mailbox/get');
		expect(errors[0]?.error).toEqual(new Error('disk on fire'));
	});
});
