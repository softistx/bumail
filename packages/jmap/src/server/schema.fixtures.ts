/**
 * A light JSON Schema checker, enough to tell a real answer from an
 * OpenAPI document that drifted: the keywords the document uses, and no
 * dependency. `unknownKeywords` keeps the document within them.
 */

/** A schema or a document, as parsed: JSON, read loosely. */
type Json = any;

/** What `$ref` points at, from the document. */
type Resolve = (ref: string) => Json;

/** The assertions `mismatches` checks. */
const ASSERTIONS = [
	'$ref',
	'type',
	'const',
	'enum',
	'pattern',
	'minLength',
	'maxLength',
	'minimum',
	'maximum',
	'minItems',
	'maxItems',
	'prefixItems',
	'items',
	'required',
	'minProperties',
	'maxProperties',
	'propertyNames',
	'patternProperties',
	'properties',
	'additionalProperties',
	'allOf',
	'oneOf',
	'not',
];

/** Keywords that assert nothing. */
const ANNOTATIONS = [
	'title',
	'description',
	'example',
	'examples',
	'default',
	'deprecated',
	'contentMediaType',
];

const KNOWN = new Set([...ASSERTIONS, ...ANNOTATIONS]);

/** The JSON type of a value, `integer` for a whole number. */
export function typeOf(value: unknown): string {
	if (value === null) return 'null';
	if (Array.isArray(value)) return 'array';
	if (typeof value === 'number')
		return Number.isInteger(value) ? 'integer' : 'number';
	return typeof value;
}

/** The subschemas of a schema, with where each is. */
function subschemas(schema: Json, at: string): [string, unknown][] {
	const out: [string, unknown][] = [];
	for (const key of ['items', 'not', 'propertyNames', 'additionalProperties'])
		if (key in schema) out.push([`${at}/${key}`, schema[key]]);
	for (const key of ['prefixItems', 'allOf', 'oneOf'])
		for (const [i, one] of (schema[key] ?? []).entries())
			out.push([`${at}/${key}/${i}`, one]);
	for (const key of ['properties', 'patternProperties'])
		for (const [name, one] of Object.entries(schema[key] ?? {}))
			out.push([`${at}/${key}/${name}`, one]);
	return out;
}

/**
 * Every keyword of a schema, and of its subschemas, that `mismatches`
 * would not check, and every boolean schema, as `where: why`.
 * `additionalProperties` may be `true` or `false`: `mismatches` reads both.
 */
export function unknownKeywords(schema: unknown, at: string): string[] {
	if (typeof schema === 'boolean')
		return at.endsWith('/additionalProperties')
			? []
			: [`${at}: a boolean schema`];
	if (typeOf(schema) !== 'object') return [`${at}: not a schema`];
	const own = Object.keys(schema as Json)
		.filter((key) => !KNOWN.has(key))
		.map((key) => `${at}: unknown keyword ${key}`);
	return own.concat(
		subschemas(schema, at).flatMap(([where, one]) =>
			unknownKeywords(one, where),
		),
	);
}

/** Every schema of an OpenAPI document: `components.schemas`, and each `schema`. */
export function schemasOf(value: unknown, at = '#'): [string, unknown][] {
	if (typeOf(value) !== 'object' && !Array.isArray(value)) return [];
	return Object.entries(value as Json).flatMap(([key, one]) =>
		key === 'schema' || at === '#/components/schemas'
			? [[`${at}/${key}`, one] as [string, unknown]]
			: schemasOf(one, `${at}/${key}`),
	);
}

function stringMismatches(schema: Json, value: string, at: string): string[] {
	const out: string[] = [];
	if (
		schema.pattern !== undefined &&
		!new RegExp(schema.pattern, 'u').test(value)
	)
		out.push(`${at}: does not match ${schema.pattern}`);
	if (value.length < (schema.minLength ?? 0)) out.push(`${at}: too short`);
	if (value.length > (schema.maxLength ?? Infinity))
		out.push(`${at}: too long`);
	return out;
}

function numberMismatches(schema: Json, value: number, at: string): string[] {
	const out: string[] = [];
	if (value < (schema.minimum ?? -Infinity)) out.push(`${at}: too small`);
	if (value > (schema.maximum ?? Infinity)) out.push(`${at}: too large`);
	return out;
}

function arrayMismatches(
	resolve: Resolve,
	schema: Json,
	value: unknown[],
	at: string,
): string[] {
	const out: string[] = [];
	if (value.length < (schema.minItems ?? 0)) out.push(`${at}: too few items`);
	if (value.length > (schema.maxItems ?? Infinity))
		out.push(`${at}: too many items`);
	const prefix: Json[] = schema.prefixItems ?? [];
	value.forEach((item, i) => {
		const one = prefix[i] ?? schema.items;
		if (one !== undefined)
			out.push(...mismatches(resolve, one, item, `${at}[${i}]`));
	});
	return out;
}

/** A property's checks: `properties`, `patternProperties`, `additionalProperties`. */
function propertyMismatches(
	resolve: Resolve,
	schema: Json,
	key: string,
	value: unknown,
	at: string,
): string[] {
	const out: string[] = [];
	if (schema.propertyNames !== undefined)
		out.push(...mismatches(resolve, schema.propertyNames, key, `${at} (name)`));
	const patterns = Object.entries<Json>(schema.patternProperties ?? {}).filter(
		([pattern]) => new RegExp(pattern, 'u').test(key),
	);
	for (const [, one] of patterns)
		out.push(...mismatches(resolve, one, value, at));
	const additional = schema.additionalProperties;
	if (schema.properties !== undefined && Object.hasOwn(schema.properties, key))
		out.push(...mismatches(resolve, schema.properties[key], value, at));
	else if (patterns.length === 0 && additional === false)
		out.push(`${at}: is not a property`);
	else if (patterns.length === 0 && typeOf(additional) === 'object')
		out.push(...mismatches(resolve, additional, value, at));
	return out;
}

function objectMismatches(
	resolve: Resolve,
	schema: Json,
	value: Json,
	at: string,
): string[] {
	const out: string[] = [];
	const keys = Object.keys(value);
	for (const key of schema.required ?? [])
		if (!Object.hasOwn(value, key)) out.push(`${at}: lacks ${key}`);
	if (keys.length < (schema.minProperties ?? 0))
		out.push(`${at}: too few properties`);
	if (keys.length > (schema.maxProperties ?? Infinity))
		out.push(`${at}: too many properties`);
	for (const key of keys)
		out.push(
			...propertyMismatches(resolve, schema, key, value[key], `${at}.${key}`),
		);
	return out;
}

function combinatorMismatches(
	resolve: Resolve,
	schema: Json,
	value: unknown,
	at: string,
): string[] {
	const out: string[] = [];
	for (const one of schema.allOf ?? [])
		out.push(...mismatches(resolve, one, value, at));
	if (
		schema.not !== undefined &&
		mismatches(resolve, schema.not, value, at).length === 0
	)
		out.push(`${at}: matches what it must not`);
	if (schema.oneOf !== undefined) {
		const matched = (schema.oneOf as Json[]).filter(
			(one) => mismatches(resolve, one, value, at).length === 0,
		).length;
		if (matched !== 1) out.push(`${at}: matches ${matched} of oneOf, not 1`);
	}
	return out;
}

/** The value's type against `type`, or why not. */
function typeMismatch(schema: Json, value: unknown, at: string) {
	if (schema.type === undefined) return undefined;
	const types = [schema.type].flat();
	const type = typeOf(value);
	return types.includes(type) ||
		(type === 'integer' && types.includes('number'))
		? undefined
		: `${at}: is ${type}, not ${types.join(' or ')}`;
}

/** Where a value breaks a schema, as `path: why` lines; none when it fits. */
export function mismatches(
	resolve: Resolve,
	schema: Json,
	value: unknown,
	at = '$',
): string[] {
	const out: string[] =
		schema.$ref === undefined
			? []
			: mismatches(resolve, resolve(schema.$ref), value, at);
	const wrongType = typeMismatch(schema, value, at);
	if (wrongType !== undefined) return [...out, wrongType];
	if ('const' in schema && !Bun.deepEquals(value, schema.const))
		out.push(`${at}: is not ${JSON.stringify(schema.const)}`);
	if (schema.enum !== undefined && !schema.enum.includes(value))
		out.push(`${at}: ${JSON.stringify(value)} is not in the enum`);
	if (typeof value === 'string')
		out.push(...stringMismatches(schema, value, at));
	if (typeof value === 'number')
		out.push(...numberMismatches(schema, value, at));
	if (Array.isArray(value))
		out.push(...arrayMismatches(resolve, schema, value, at));
	if (typeOf(value) === 'object')
		out.push(...objectMismatches(resolve, schema, value, at));
	return out.concat(combinatorMismatches(resolve, schema, value, at));
}
