import { afterEach, describe, expect, test } from 'bun:test';
import { CORE, type Harness, harness, MAIL } from './app.fixtures';

type Problem = { type: string; status: number; limit?: string; detail: string };

const post = (methodCalls: unknown[], extra: object = {}) => ({
	method: 'POST',
	body: JSON.stringify({ using: [CORE, MAIL], methodCalls, ...extra }),
});

/** A condition under `depth` nested ANDs. */
function nested(depth: number): unknown {
	let filter: unknown = { hasKeyword: '$seen' };
	for (let i = 0; i < depth; i++)
		filter = { operator: 'AND', conditions: [filter] };
	return filter;
}

describe('hostile input: the caps', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('maxConcurrentUpload: an upload past it is a 429, and the slot comes back', async () => {
		h = await harness('memory', { limits: { maxConcurrentUpload: 1 } });
		let release: () => void = () => {};
		const held = new ReadableStream<Uint8Array>({
			start(controller) {
				release = () => {
					controller.enqueue(new TextEncoder().encode('held'));
					controller.close();
				};
			},
		});
		const url = `/jmap/upload/${h.alice.id}`;
		const first = h.fetch(url, { method: 'POST', body: held });
		await Bun.sleep(10);
		const second = await h.fetch(url, { method: 'POST', body: 'x' });
		expect(second.status).toBe(429);
		expect(((await second.json()) as Problem).limit).toBe(
			'maxConcurrentUpload',
		);
		release();
		expect((await first).status).toBe(201);
		expect((await h.fetch(url, { method: 'POST', body: 'x' })).status).toBe(
			201,
		);
	});

	test('a reference path has at most 1024 characters and 32 segments', async () => {
		h = await harness();
		const ref = (path: string) => ({ resultOf: 'e', name: 'Core/echo', path });
		const { methodResponses } = await h.api([
			['Core/echo', { a: 1 }, 'e'],
			['Core/echo', { '#x': ref(`/${'a'.repeat(1024)}`) }, 'long'],
			['Core/echo', { '#x': ref('/a'.repeat(33)) }, 'deep'],
		]);
		expect(methodResponses[1]?.[1].description).toBe(
			'The path is longer than 1024 characters',
		);
		expect(methodResponses[2]?.[1].description).toBe(
			'The path has more than 32 segments',
		);
	});

	test('a filter nests at most 16 operators and holds at most 256 conditions', async () => {
		h = await harness();
		expect(
			(await h.call('Email/query', { filter: nested(16) })).args.ids,
		).toEqual([]);
		expect(
			(await h.call('Email/query', { filter: nested(17) })).args.description,
		).toBe('Operators nest deeper than 16');
		const wide = {
			operator: 'OR',
			conditions: Array.from({ length: 256 }, () => ({ hasKeyword: '$seen' })),
		};
		expect(
			(await h.call('Email/query', { filter: wide })).args.description,
		).toBe('The filter holds more than 256 conditions');
	});

	test('sort holds at most 16 comparators, properties 256 names, using 64 capabilities', async () => {
		h = await harness();
		const sort = Array.from({ length: 17 }, () => ({ property: 'size' }));
		expect((await h.call('Email/query', { sort })).args.description).toBe(
			'sort must be an array of at most 16 comparators',
		);
		const properties = Array.from({ length: 257 }, () => 'id');
		expect((await h.call('Mailbox/get', { properties })).args.description).toBe(
			'properties must be an array of at most 256 property names',
		);
		const using = await h.fetch('/jmap/api', {
			method: 'POST',
			body: JSON.stringify({ using: Array(65).fill(CORE), methodCalls: [] }),
		});
		expect(((await using.json()) as Problem).detail).toBe(
			'using is not an array of capability names',
		);
	});

	test('createdIds holds at most maxObjectsInSet ids', async () => {
		h = await harness('memory', { limits: { maxObjectsInSet: 2 } });
		const createdIds = { a: 'x', b: 'y', c: 'z' };
		const response = await h.fetch('/jmap/api', post([], { createdIds }));
		expect(await response.json()).toMatchObject({
			type: 'urn:ietf:params:jmap:error:notRequest',
			detail: 'createdIds holds more than 2 ids',
		});
	});

	test('an Authorization header over 8 KiB is not read', async () => {
		let asked = 0;
		h = await harness('memory', {
			authenticate: () => {
				asked++;
				return null;
			},
		});
		const header = (size: number) => `Bearer ${'a'.repeat(size - 7)}`;
		const over = await h.fetch('/.well-known/jmap', {
			headers: { authorization: header(8193) },
		});
		expect(over.status).toBe(401);
		expect(asked).toBe(0);
		await h.fetch('/.well-known/jmap', {
			headers: { authorization: header(8192) },
		});
		expect(asked).toBe(1);
	});
});
