import { afterAll, describe, expect, test } from 'bun:test';
import { AcmeError } from '../errors';
import { http01Responder, MAX_RESPONDER_TOKENS } from './responder';

/** RFC 8555 §8.3's example token, and a key authorization made of it. */
const TOKEN = 'LoqXcYV8q5ONbJQxbmR7SCTNo3tiAXDfowyjxAjEuX0';
const ANSWER = `${TOKEN}.9jg46WB3rR_AHD-EBXdN7cBkH1WOu0tA3M9fm21mqTI`;
const PATH = `/.well-known/acme-challenge/${TOKEN}`;

const get = (path: string, method = 'GET') =>
	new Request(`http://example.com${path}`, { method });

describe('http01Responder (RFC 8555 §8.3)', () => {
	test('serves a token set, as application/octet-stream, until removed', async () => {
		const responder = http01Responder();
		responder.set(TOKEN, ANSWER);
		const answer = responder.fetch(get(PATH));
		expect(answer.status).toBe(200);
		expect(answer.headers.get('content-type')).toBe('application/octet-stream');
		expect(await answer.text()).toBe(ANSWER);
		expect(responder.size).toBe(1);
		responder.remove(TOKEN);
		expect(responder.fetch(get(PATH)).status).toBe(404);
		expect(responder.size).toBe(0);
	});

	test('answers HEAD with no body', async () => {
		const responder = http01Responder();
		responder.set(TOKEN, ANSWER);
		const answer = responder.fetch(get(PATH, 'HEAD'));
		expect(answer.status).toBe(200);
		expect(await answer.text()).toBe('');
	});

	test.each([
		'/',
		'/.well-known/acme-challenge/',
		'/.well-known/acme-challenge/other',
		`/.well-known/acme-challenge/${TOKEN}/x`,
		`/.well-known/acme-challenge/../acme-challenge/${TOKEN}x`,
		`/x/.well-known/acme-challenge/${TOKEN}`,
	])('answers %p with 404', (path) => {
		const responder = http01Responder();
		responder.set(TOKEN, ANSWER);
		expect(responder.fetch(get(path)).status).toBe(404);
	});

	test('answers another method than GET or HEAD with 404', () => {
		const responder = http01Responder();
		responder.set(TOKEN, ANSWER);
		expect(responder.fetch(get(PATH, 'POST')).status).toBe(404);
		expect(responder.fetch(get(PATH, 'DELETE')).status).toBe(404);
	});

	test('refuses a token that is not base64url, which could become a path', () => {
		const responder = http01Responder();
		expect(() => responder.set('../../etc/passwd', 'x.y')).toThrow(
			new AcmeError(
				'INVALID_TOKEN',
				'http01Path(): a challenge token is a non-empty base64url string of at most 1024 characters, not "../../etc/passwd"',
			),
		);
	});

	test('refuses a key authorization not made of its token', () => {
		const responder = http01Responder();
		for (const answer of ['other.abc', `${TOKEN}.`, `${TOKEN}.a b`, 42]) {
			expect(() => responder.set(TOKEN, answer as never)).toThrow(
				'http01Responder(): the key authorization of a token is "<token>.<thumbprint>"',
			);
		}
	});

	test(`holds ${MAX_RESPONDER_TOKENS} tokens at most`, () => {
		const responder = http01Responder();
		for (let i = 0; i < MAX_RESPONDER_TOKENS; i++) {
			responder.set(`t${i}`, `t${i}.x`);
		}
		responder.set('t0', 't0.y');
		expect(() => responder.set('more', 'more.x')).toThrow(
			`http01Responder(): it already serves ${MAX_RESPONDER_TOKENS} tokens; remove some first`,
		);
	});

	test('removing a token never set is no error', () => {
		const responder = http01Responder();
		responder.remove(TOKEN);
		responder.remove('../x');
		expect(responder.size).toBe(0);
	});

	describe('as the fetch of Bun.serve', () => {
		const responder = http01Responder();
		const server = Bun.serve({ port: 0, fetch: responder.fetch });
		afterAll(() => server.stop(true));

		test('serves over HTTP', async () => {
			responder.set(TOKEN, ANSWER);
			const base = `http://127.0.0.1:${server.port}`;
			expect(await (await fetch(`${base}${PATH}`)).text()).toBe(ANSWER);
			expect((await fetch(`${base}/.well-known/acme-challenge/x`)).status).toBe(
				404,
			);
		});
	});
});
