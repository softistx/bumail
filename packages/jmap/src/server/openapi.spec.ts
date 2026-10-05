import { afterEach, describe, expect, test } from 'bun:test';
import { alxia } from '@alxia/core';
import { matchesSpec } from '@alxia/openapi';
import { type Harness, harness, MAIL, ORIGIN, SIMPLE } from './app.fixtures';
import {
	operationsOf,
	readDocument,
	refsOf,
	resolve,
} from './openapi.fixtures';
import { mismatches, schemasOf, unknownKeywords } from './schema.fixtures';

const document = await readDocument();
const deref = (ref: string) => resolve(document, ref);

/**
 * Both ways: every operation has its route and, `strict`, every route its
 * operation, but for the host's own route, which the document does not
 * describe.
 */
const host = {
	strict: true,
	exclude: (route: { path: string }) => route.path === '/health',
};

/** An object of the document, through its `$ref`. */
const followed = (value: any) =>
	value?.$ref === undefined ? value : (resolve(document, value.$ref) as any);

/**
 * Where a real response breaks what the document says of its status: each
 * header declared there present, and equal to its `const` when it has one;
 * a JSON body fitting the schema of its content type.
 */
async function misfits(
	response: Response,
	path: string,
	method: string,
	status: number,
): Promise<string[]> {
	const declared = followed(
		document.paths[path][method].responses[String(status)],
	);
	if (declared === undefined) return [`${status} is not documented`];
	const out: string[] = [];
	if (response.status !== status) out.push(`status ${response.status}`);
	for (const [name, header] of Object.entries<any>(declared.headers ?? {})) {
		const schema = followed(header).schema;
		const value = response.headers.get(name);
		if (value === null) out.push(`${name}: missing`);
		else if ('const' in schema && value !== schema.const)
			out.push(`${name}: ${value}, not ${schema.const}`);
	}
	const type = (response.headers.get('content-type') ?? '').split(';')[0] ?? '';
	const content = declared.content?.[type];
	if (type.endsWith('json')) {
		if (content === undefined) out.push(`${type}: not documented`);
		else out.push(...mismatches(deref, content.schema, await response.json()));
	}
	return out;
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

	test('uses only the schema keywords the checker reads, and no boolean schema', () => {
		const schemas = schemasOf(document);
		expect(schemas.length).toBeGreaterThan(20);
		expect(schemas.flatMap(([at, one]) => unknownKeywords(one, at))).toEqual(
			[],
		);
		expect(
			unknownKeywords(
				{ type: 'object', properties: { a: { format: 'email' }, b: true } },
				'#/x',
			),
		).toEqual([
			'#/x/properties/a: unknown keyword format',
			'#/x/properties/b: a boolean schema',
		]);
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
		let message = '';
		try {
			matchesSpec(h.host, operationsOf(document), host);
		} catch (error) {
			message = String(error);
		}
		expect(message).toContain('POST /jmap/api (api)');
		expect(message).toContain('POST /mail/v1/api');
	});

	test('a route the document does not describe fails', async () => {
		h = await harness();
		const grown = alxia()
			.plugin(h.server)
			.get('/jmap/eventsource', ({ reply }) => reply(200, ''));
		expect(() =>
			matchesSpec(grown, operationsOf(document), { strict: true }),
		).toThrow(/GET \/jmap\/eventsource/);
	});

	test('an operation no route serves fails', async () => {
		h = await harness();
		const grown = structuredClone(document);
		grown.paths['/eventsource'] = {
			servers: document.paths['/api'].servers,
			get: { operationId: 'eventSource', responses: {} },
		};
		expect(() => matchesSpec(h.host, operationsOf(grown), host)).toThrow(
			/GET \/jmap\/eventsource \(eventSource\)/,
		);
	});
});

describe('real answers fit the document', () => {
	let h: Harness;
	afterEach(() => h.close());

	test('the session, an API response with an error, an upload, and problems: headers and bodies', async () => {
		h = await harness();
		const session = await h.fetch('/.well-known/jmap');
		expect(await misfits(session, '/.well-known/jmap', 'get', 200)).toEqual([]);

		const answer = await h.fetch('/jmap/api', {
			method: 'POST',
			body: JSON.stringify({
				using: [MAIL],
				methodCalls: [
					['Mailbox/get', { accountId: h.alice.id, ids: null }, 'm'],
					['Mailbox/nope', {}, 'x'],
				],
			}),
		});
		expect(await misfits(answer.clone(), '/api', 'post', 200)).toEqual([]);
		expect((await answer.json()).methodResponses[1][0]).toBe('error');

		const upload = await h.fetch(`/jmap/upload/${h.alice.id}`, {
			method: 'POST',
			headers: { 'content-type': 'message/rfc822' },
			body: SIMPLE,
		});
		expect(await misfits(upload, '/upload/{accountId}', 'post', 201)).toEqual(
			[],
		);

		const download = '/download/{accountId}/{blobId}/{name}';
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
				download,
				'get',
				404,
			],
		];
		for (const [response, path, method, status] of problems) {
			expect(response.headers.get('content-type')).toBe(
				'application/problem+json',
			);
			expect(await misfits(response, path, method, status)).toEqual([]);
		}
	});

	test('a download: the 200, the 206 and the 416, with their headers', async () => {
		h = await harness();
		const message = await h.add(SIMPLE);
		const url = `/jmap/download/${h.alice.id}/${message.blobId}/mail.eml`;
		const path = '/download/{accountId}/{blobId}/{name}';
		const whole = await h.fetch(url);
		expect(await misfits(whole, path, 'get', 200)).toEqual([]);
		const part = await h.fetch(url, { headers: { range: 'bytes=0-4' } });
		expect(await misfits(part, path, 'get', 206)).toEqual([]);
		const past = await h.fetch(url, {
			headers: { range: `bytes=${message.size}-` },
		});
		expect(await misfits(past, path, 'get', 416)).toEqual([]);
	});

	test('a drifted schema or header is caught', async () => {
		h = await harness();
		const session = await (await h.fetch('/.well-known/jmap')).json();
		const drifted = structuredClone(document);
		drifted.components.schemas.Session.required.push('pushUrl');
		drifted.components.schemas.Account.properties.isReadOnly.const = true;
		const look = (ref: string) => resolve(drifted, ref);
		expect(
			mismatches(look, drifted.components.schemas.Session, session),
		).toEqual([
			'$: lacks pushUrl',
			`$.accounts.${h.alice.id}.isReadOnly: is not true`,
		]);
		document.components.headers.NoStore.schema.const = 'no-cache';
		try {
			const answer = await h.fetch('/.well-known/jmap');
			expect(await misfits(answer, '/.well-known/jmap', 'get', 200)).toEqual([
				'Cache-Control: no-store, not no-cache',
			]);
		} finally {
			document.components.headers.NoStore.schema.const = 'no-store';
		}
	});
});
