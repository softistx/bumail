import { afterEach, describe, expect, test } from 'bun:test';
import { CORE, type Harness, harness, MAIL } from './app.fixtures';

type Problem = { type: string; status: number; limit?: string; detail: string };

const body = (methodCalls: unknown[]) =>
	JSON.stringify({ using: [CORE, MAIL], methodCalls });

/** A chunked body that counts what was pulled from it: `size` bytes of spaces, no Content-Length. */
function counted(size: number, chunk = 64 * 1024) {
	const pulled = { bytes: 0 };
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			const n = Math.min(chunk, size - pulled.bytes);
			if (n <= 0) return controller.close();
			controller.enqueue(new Uint8Array(n).fill(0x20));
			pulled.bytes += n;
		},
	});
	return { stream, pulled };
}

/** A body that streams `size` bytes of spaces, no Content-Length. */
function streamOf(size: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
	let sent = 0;
	return new ReadableStream({
		pull(controller) {
			const n = Math.min(chunk, size - sent);
			if (n <= 0) return controller.close();
			controller.enqueue(new Uint8Array(n).fill(0x20));
			sent += n;
		},
	});
}

describe('hostile input', () => {
	let h: Harness;
	afterEach(() => h.close());

	const problem = async (response: Response) => ({
		...((await response.json()) as Problem),
		status: response.status,
	});

	test('maxSizeRequest: a Content-Length above it is refused unread, a body that streams past it is cut', async () => {
		h = await harness('memory', { limits: { maxSizeRequest: 1000 } });
		const declared = await h.fetch('/jmap/api', {
			method: 'POST',
			headers: { 'content-length': '5000' },
			body: 'x'.repeat(5000),
		});
		expect(await problem(declared)).toMatchObject({
			status: 413,
			type: 'urn:ietf:params:jmap:error:limit',
			limit: 'maxSizeRequest',
		});
		const streamed = await h.fetch('/jmap/api', {
			method: 'POST',
			body: streamOf(1_000_000),
		});
		expect(await problem(streamed)).toMatchObject({
			status: 413,
			limit: 'maxSizeRequest',
		});
		const lying = await h.fetch('/jmap/api', {
			method: 'POST',
			headers: { 'content-length': '10' },
			body: streamOf(1_000_000),
		});
		expect(await problem(lying)).toMatchObject({
			status: 413,
			limit: 'maxSizeRequest',
		});
	});

	test('maxCallsInRequest, maxJsonDepth and maxJsonTokens are limits', async () => {
		h = await harness('memory', { limits: { maxJsonTokens: 500 } });
		const calls = Array.from({ length: 17 }, (_, i) => [
			'Core/echo',
			{},
			`c${i}`,
		]);
		const many = await h.fetch('/jmap/api', {
			method: 'POST',
			body: body(calls),
		});
		expect(await problem(many)).toMatchObject({
			status: 400,
			limit: 'maxCallsInRequest',
		});
		const deep = await h.fetch('/jmap/api', {
			method: 'POST',
			body: `${'['.repeat(65)}${']'.repeat(65)}`,
		});
		expect(await problem(deep)).toMatchObject({ limit: 'maxJsonDepth' });
		const wide = await h.fetch('/jmap/api', {
			method: 'POST',
			body: body([['Core/echo', { a: Array(600).fill(1) }, 'c']]),
		});
		expect(await problem(wide)).toMatchObject({ limit: 'maxJsonTokens' });
	});

	test('maxObjectsInGet and maxObjectsInSet are requestTooLarge', async () => {
		h = await harness();
		const ids = Array.from({ length: 501 }, (_, i) => `id${i}`);
		expect((await h.call('Email/get', { ids })).args.type).toBe(
			'requestTooLarge',
		);
		expect((await h.call('Mailbox/get', { ids })).args.type).toBe(
			'requestTooLarge',
		);
		expect((await h.call('Email/set', { destroy: ids })).args.type).toBe(
			'requestTooLarge',
		);
	});

	test('maxSizeUpload and the upload quota', async () => {
		h = await harness('memory', {
			limits: { maxSizeUpload: 100, uploadQuota: 150 },
		});
		const big = await h.fetch(`/jmap/upload/${h.alice.id}`, {
			method: 'POST',
			body: streamOf(1000),
		});
		expect(await problem(big)).toMatchObject({
			status: 413,
			limit: 'maxSizeUpload',
		});
		expect(
			(
				await h.fetch(`/jmap/upload/${h.alice.id}`, {
					method: 'POST',
					body: 'a'.repeat(100),
				})
			).status,
		).toBe(201);
		const over = await h.fetch(`/jmap/upload/${h.alice.id}`, {
			method: 'POST',
			body: 'b'.repeat(100),
		});
		expect(await problem(over)).toMatchObject({
			status: 413,
			limit: 'uploadQuota',
		});
	});

	test('maxConcurrentRequests: a request past it is a 429, and the slot comes back', async () => {
		h = await harness('memory', { limits: { maxConcurrentRequests: 1 } });
		let release: () => void = () => {};
		const held = new ReadableStream<Uint8Array>({
			start(controller) {
				release = () => {
					controller.enqueue(new TextEncoder().encode(body([])));
					controller.close();
				};
			},
		});
		const first = h.fetch('/jmap/api', { method: 'POST', body: held });
		await Bun.sleep(10);
		const second = await h.fetch('/jmap/api', {
			method: 'POST',
			body: body([]),
		});
		expect(await problem(second)).toMatchObject({
			status: 429,
			limit: 'maxConcurrentRequests',
		});
		release();
		expect((await first).status).toBe(200);
		expect(
			(await h.fetch('/jmap/api', { method: 'POST', body: body([]) })).status,
		).toBe(200);
	});

	test('a chunked body past maxSizeRequest or maxSizeUpload is refused early, as the limit problem', async () => {
		h = await harness('memory', {
			limits: {
				maxSizeRequest: 100_000,
				maxSizeUpload: 100_000,
				maxConcurrentRequests: 1,
				maxConcurrentUpload: 1,
			},
		});
		const offered = 64 * 1024 * 1024;
		for (const [path, limit] of [
			['/jmap/api', 'maxSizeRequest'],
			[`/jmap/upload/${h.alice.id}`, 'maxSizeUpload'],
		] as const) {
			const { stream, pulled } = counted(offered);
			const response = await h.fetch(path, { method: 'POST', body: stream });
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
			expect(await problem(response)).toEqual({
				type: 'urn:ietf:params:jmap:error:limit',
				status: 413,
				limit,
				detail: `The ${limit === 'maxSizeUpload' ? 'upload' : 'request'} is larger than 100000 bytes`,
			});
			// Read no further than the chunk that passed the limit, and a
			// little read-ahead: never the 64 MiB offered.
			expect(pulled.bytes).toBeLessThan(1024 * 1024);
		}
		// The refusal gave the account's request and upload slots back.
		expect(
			(await h.fetch('/jmap/api', { method: 'POST', body: body([]) })).status,
		).toBe(200);
		expect(
			(
				await h.fetch(`/jmap/upload/${h.alice.id}`, {
					method: 'POST',
					body: 'a',
				})
			).status,
		).toBe(201);
	});

	test('a path parameter that is not an Id is the 404 problem, by download and by upload', async () => {
		h = await harness();
		for (const [path, init, detail] of [
			[`/jmap/download/${h.alice.id}/..%2Fetc/x`, {}, 'No blob has this id'],
			[`/jmap/download/a%20b/blob/x`, {}, 'No blob has this id'],
			[
				`/jmap/upload/${'x'.repeat(256)}`,
				{ method: 'POST', body: 'x' },
				'No account has this id',
			],
		] as const) {
			const response = await h.fetch(path, init);
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
			expect(await problem(response)).toEqual({
				type: 'about:blank',
				status: 404,
				detail,
			});
		}
		// Authentication still comes first.
		const anonymous = await h.fetch(`/jmap/download/a%20b/blob/x`, {
			headers: { authorization: 'Bearer nobody' },
		});
		expect(anonymous.status).toBe(401);
	});

	test('an upload refused for its accountId has its body cancelled, not left unread', async () => {
		h = await harness();
		const cancelled = Promise.withResolvers<unknown>();
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(1024).fill(0x20));
			},
			cancel: cancelled.resolve,
		});
		const response = await h.fetch(`/jmap/upload/${'x'.repeat(256)}`, {
			method: 'POST',
			body: stream,
		});
		expect(response.status).toBe(404);
		// It never ends: only a cancel settles this.
		await cancelled.promise;
	});
});
