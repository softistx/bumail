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
 * The document as the operations `@alxia/openapi-routes` checks: each with
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

function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number')
		return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

/**
 * Where a value breaks a schema of the document, as `path: why` lines. A
 * light check of the JSON Schema keywords the document uses, not a
 * validator: enough to tell a real answer from a document that drifted.
 */
export function mismatches(
	document: Json,
	schema: Json,
	value: unknown,
	at = '$',
): string[] {
	const check = (one: Json, item: unknown, where = at) =>
		mismatches(document, one, item, where);
	const out: string[] = [];
	if (schema.$ref !== undefined)
		out.push(...check(resolve(document, schema.$ref) as Json, value));
	if (schema.type !== undefined) {
		const types = [schema.type].flat();
		const type = typeOf(value);
		if (
			!types.includes(type) &&
			!(type === 'integer' && types.includes('number'))
		)
			return [...out, `${at}: is ${type}, not ${types.join(' or ')}`];
	}
	if ('const' in schema && !Bun.deepEquals(value, schema.const))
		out.push(`${at}: is not ${JSON.stringify(schema.const)}`);
	if (schema.enum !== undefined && !schema.enum.includes(value))
		out.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
	if (typeof value === 'string') {
		if (
			schema.pattern !== undefined &&
			!new RegExp(schema.pattern, 'u').test(value)
		)
			out.push(`${at}: does not match ${schema.pattern}`);
		if (value.length < (schema.minLength ?? 0)) out.push(`${at}: too short`);
		if (value.length > (schema.maxLength ?? Infinity))
			out.push(`${at}: too long`);
	}
	if (typeof value === 'number') {
		if (value < (schema.minimum ?? -Infinity)) out.push(`${at}: too small`);
		if (value > (schema.maximum ?? Infinity)) out.push(`${at}: too large`);
	}
	if (Array.isArray(value)) {
		if (value.length < (schema.minItems ?? 0)) out.push(`${at}: too few items`);
		if (value.length > (schema.maxItems ?? Infinity))
			out.push(`${at}: too many items`);
		const prefix: Json[] = schema.prefixItems ?? [];
		value.forEach((item, i) => {
			const one = prefix[i] ?? schema.items;
			if (one !== undefined) out.push(...check(one, item, `${at}[${i}]`));
		});
	}
	if (typeOf(value) === 'object') {
		const object = value as Json;
		const keys = Object.keys(object);
		for (const key of schema.required ?? [])
			if (!(key in object)) out.push(`${at}: lacks ${key}`);
		if (keys.length < (schema.minProperties ?? 0))
			out.push(`${at}: too few properties`);
		if (keys.length > (schema.maxProperties ?? Infinity))
			out.push(`${at}: too many properties`);
		for (const key of keys) {
			const where = `${at}.${key}`;
			if (schema.propertyNames !== undefined)
				out.push(...check(schema.propertyNames, key, `${where} (name)`));
			const patterns = Object.entries<Json>(
				schema.patternProperties ?? {},
			).filter(([pattern]) => new RegExp(pattern, 'u').test(key));
			for (const [, one] of patterns)
				out.push(...check(one, object[key], where));
			if (schema.properties?.[key] !== undefined)
				out.push(...check(schema.properties[key], object[key], where));
			else if (patterns.length === 0 && schema.additionalProperties === false)
				out.push(`${where}: is not a property`);
			else if (
				patterns.length === 0 &&
				typeof schema.additionalProperties === 'object'
			)
				out.push(...check(schema.additionalProperties, object[key], where));
		}
	}
	for (const one of schema.allOf ?? []) out.push(...check(one, value));
	if (schema.not !== undefined && check(schema.not, value).length === 0)
		out.push(`${at}: matches what it must not`);
	if (schema.oneOf !== undefined) {
		const matched = (schema.oneOf as Json[]).filter(
			(one) => check(one, value).length === 0,
		).length;
		if (matched !== 1) out.push(`${at}: matches ${matched} of oneOf, not 1`);
	}
	return out;
}
