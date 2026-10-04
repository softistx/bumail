import { afterEach, describe, expect, test } from 'bun:test';
import { alxia } from '@alxia/core';
import { matchesSpec } from '@alxia/openapi-routes';
import { type Harness, harness, MAIL, ORIGIN, SIMPLE } from './app.fixtures';
import {
	mismatches,
	operationsOf,
	readDocument,
	refsOf,
	resolve,
} from './openapi.fixtures';

const document = await readDocument();

/** The host's own route, which the document does not describe. */
const host = { exclude: (route: { path: string }) => route.path === '/health' };

/** A response's schema in the document, through its `$ref`s. */
function schemaOf(
	path: string,
	method: string,
	status: number,
	media = 'application/json',
) {
	let response = document.paths[path][method].responses[String(status)];
	if (response.$ref !== undefined) response = resolve(document, response.$ref);
	return response.content[media].schema;
}

describe('the OpenAPI document', () => {
	test('is OpenAPI 3.1, and every $ref resolves inside it', () => {
		expect(document.openapi).toMatch(/^3\.1\.\d+$/);
		const refs = refsOf(document);
		expect(refs.length).toBeGreaterThan(0);
		const broken = refs.filter(
			([, ref]) => resolve(document, ref) === undefined,
		);
		expect(broken).toEqual([]);
	});

	test('names each operation once', () => {
		const ids = operationsOf(document).map(
			(op) => op.schema?.detail?.operationId,
		);
		expect(ids).toEqual(['getSession', 'api', 'download', 'upload']);
	});

	test('its server variables default to the options the specs use, and basePath to the code’s', () => {
		expect(document.servers[0].variables.origin.default).toBe(ORIGIN);
		const paths = operationsOf(document).map((op) => `${op.method} ${op.path}`);
		expect(paths).toEqual([
			'GET /.well-known/jmap',
			'POST /jmap/api',
			'GET /jmap/download/:accountId/:blobId/:name',
			'POST /jmap/upload/:accountId',
		]);
	});
});

describe('the document and the routes', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('match both ways, on a host app with its own route', async () => {
		h = await harness();
		matchesSpec(h.host, operationsOf(document), host);
	});

	test('match under another basePath, given as the server variable', async () => {
		h = await harness('memory', { basePath: '/mail/v1' });
		matchesSpec(h.host, operationsOf(document, { basePath: '/mail/v1' }), host);
		expect(() => matchesSpec(h.host, operationsOf(document), host)).toThrow(
			/3 operations have no route: POST \/jmap\/api .*; 3 routes have no operation: POST \/mail\/v1\/api/,
		);
	});

	test('a route the document does not describe fails', async () => {
		h = await harness();
		const grown = alxia()
			.use(h.server)
			.get('/jmap/eventsource', ({ reply }) => reply(200, ''));
		expect(() => matchesSpec(grown, operationsOf(document))).toThrow(
			'matchesSpec(): 1 route has no operation: GET /jmap/eventsource',
		);
	});

	test('an operation no route serves fails', async () => {
		h = await harness();
		const grown = structuredClone(document);
		grown.paths['/eventsource'] = {
			servers: document.paths['/api'].servers,
			get: { operationId: 'eventSource', responses: {} },
		};
		expect(() => matchesSpec(h.host, operationsOf(grown), host)).toThrow(
			'matchesSpec(): 1 operation has no route: GET /jmap/eventsource (eventSource)',
		);
	});
});

describe('real answers fit the document', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('the session, an API response with an error, an upload, and problems', async () => {
		h = await harness();
		const session = await (await h.fetch('/.well-known/jmap')).json();
		expect(
			mismatches(document, schemaOf('/.well-known/jmap', 'get', 200), session),
		).toEqual([]);

		const answer = await h.api([
			['Mailbox/get', { accountId: h.alice.id, ids: null }, 'm'],
			['Mailbox/nope', {}, 'x'],
		]);
		expect(answer.methodResponses[1]?.[0]).toBe('error');
		expect(mismatches(document, schemaOf('/api', 'post', 200), answer)).toEqual(
			[],
		);

		const upload = await h.fetch(`/jmap/upload/${h.alice.id}`, {
			method: 'POST',
			headers: { 'content-type': 'message/rfc822' },
			body: SIMPLE,
		});
		expect(upload.status).toBe(201);
		expect(
			mismatches(
				document,
				schemaOf('/upload/{accountId}', 'post', 201),
				await upload.json(),
			),
		).toEqual([]);

		const problems: [Response, string, string, number][] = [
			[
				await h.fetch('/jmap/api', { method: 'POST', body: '{' }),
				'/api',
				'post',
				400,
			],
			[
				await h.fetch('/jmap/api', {
					method: 'POST',
					body: JSON.stringify({ using: [MAIL, 'urn:x'], methodCalls: [] }),
				}),
				'/api',
				'post',
				400,
			],
			[
				await h.fetch('/.well-known/jmap', { token: 'nobody' }),
				'/.well-known/jmap',
				'get',
				401,
			],
			[
				await h.fetch(`/jmap/download/${h.alice.id}/nope/x`),
				'/download/{accountId}/{blobId}/{name}',
				'get',
				404,
			],
		];
		for (const [response, path, method, status] of problems) {
			expect(response.status).toBe(status);
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
			expect(
				mismatches(
					document,
					schemaOf(path, method, status, 'application/problem+json'),
					await response.json(),
				),
			).toEqual([]);
		}
	});

	test('a drifted schema is caught', async () => {
		h = await harness();
		const session = await (await h.fetch('/.well-known/jmap')).json();
		const drifted = structuredClone(document);
		drifted.components.schemas.Session.required.push('pushUrl');
		drifted.components.schemas.Account.properties.isReadOnly.const = true;
		expect(
			mismatches(drifted, drifted.components.schemas.Session, session),
		).toEqual([
			'$: lacks pushUrl',
			`$.accounts.${h.alice.id}.isReadOnly: is not true`,
		]);
	});
});
