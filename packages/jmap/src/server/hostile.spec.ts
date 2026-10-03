import { afterEach, describe, expect, test } from 'bun:test';
import { CORE, type Harness, harness, MAIL } from './app.fixtures';

type Problem = { type: string; status: number; limit?: string; detail: string };

const body = (methodCalls: unknown[]) =>
	JSON.stringify({ using: [CORE, MAIL], methodCalls });

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
});
