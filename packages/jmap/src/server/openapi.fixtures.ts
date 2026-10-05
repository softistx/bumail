import type { Method, RouteOperation, RoutePath } from '@alxia/core';

/** A part of the document, as parsed: JSON, read loosely. */
type Json = any;

/** The OpenAPI document the package ships, `@bumail/jmap/openapi.json`. */
export async function readDocument(): Promise<Json> {
	return Bun.file(new URL('../../openapi/jmap.json', import.meta.url)).json();
}

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch'];

/**
 * The path a server of the document puts its operations under: its URL
 * with each variable given in `values`, or its default, then only the path.
 */
function serverPath(server: Json, values: Readonly<Record<string, string>>) {
	const url = String(server.url).replace(
		/\{(\w+)\}/g,
		(_, name: string) => values[name] ?? server.variables?.[name]?.default,
	);
	return new URL(url).pathname.replace(/\/$/, '');
}

/**
 * The document as the operations `@alxia/openapi` checks: each with
 * its method, its full path — the path-level server's path, such as the
 * `basePath` variable, in front, `{name}` as `:name` — and its operation id.
 */
export function operationsOf(
	document: Json,
	values: Readonly<Record<string, string>> = {},
): RouteOperation[] {
	return Object.entries<Json>(document.paths).flatMap(([path, item]) => {
		const server = item.servers?.[0] ?? document.servers[0];
		const full = `${serverPath(server, values)}${path}`.replace(
			/\{(\w+)\}/g,
			':$1',
		) as RoutePath;
		return METHODS.filter((method) => item[method] !== undefined).map(
			(method) => ({
				method: method.toUpperCase() as Method,
				path: full,
				schema: { detail: { operationId: item[method].operationId } },
			}),
		);
	});
}

/** Every `$ref` in the document, with where it is. */
export function refsOf(value: unknown, at = '#'): [at: string, ref: string][] {
	if (typeof value !== 'object' || value === null) return [];
	return Object.entries(value).flatMap(([key, one]) =>
		key === '$ref' && typeof one === 'string'
			? [[at, one] as [string, string]]
			: refsOf(one, `${at}/${key}`),
	);
}

/** What a local `$ref` (`#/a/b`, RFC 6901) points at, or `undefined`. */
export function resolve(document: Json, ref: string): unknown {
	if (!ref.startsWith('#/')) return undefined;
	let at: unknown = document;
	for (const raw of ref.slice(2).split('/')) {
		const key = raw.replaceAll('~1', '/').replaceAll('~0', '~');
		if (typeof at !== 'object' || at === null || !Object.hasOwn(at, key))
			return undefined;
		at = (at as Json)[key];
	}
	return at;
}
