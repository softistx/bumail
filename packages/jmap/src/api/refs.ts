import { quoted } from '../shared/text';
import { invalidArguments, MethodError } from './errors';
import type { Invocation } from './request';
import { jsonSize } from './size';

/** What one request's back-references may still resolve to. */
export interface ReferenceBudget {
	/** Values one reference may expand to: `maxReferenceItems`. */
	readonly maxItems: number;
	/** The request's `maxReferenceBytes`, for the error. */
	readonly maxBytes: number;
	/** Bytes of JSON the request's references may still copy. */
	left: number;
}

/** The longest `path` of a ResultReference, and the most segments it may have. */
const MAX_PATH = 1024;
const MAX_SEGMENTS = 32;

const FAIL: unique symbol = Symbol('fail');

const bad = (description: string) =>
	new MethodError('invalidResultReference', description);

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

function evaluate(
	value: unknown,
	tokens: readonly string[],
	at: number,
	max: number,
): unknown {
	if (at === tokens.length) return value;
	const token = tokens[at] as string;
	if (token === '*' && Array.isArray(value)) {
		const out: unknown[] = [];
		for (const item of value) {
			const found = evaluate(item, tokens, at + 1, max);
			if (found === FAIL) return FAIL;
			if (Array.isArray(found)) out.push(...found);
			else out.push(found);
			if (out.length > max)
				throw bad(`The reference expands to more than ${max} values`);
		}
		return out;
	}
	if (Array.isArray(value)) {
		if (!/^(0|[1-9][0-9]{0,8})$/.test(token)) return FAIL;
		const index = Number(token);
		return index < value.length
			? evaluate(value[index], tokens, at + 1, max)
			: FAIL;
	}
	if (isObject(value) && Object.hasOwn(value, token)) {
		return evaluate(value[token], tokens, at + 1, max);
	}
	return FAIL;
}

/**
 * RFC 8620 §3.7's JSON Pointer, RFC 6901 with `*`: `*` on an array maps
 * the rest of the path over its items, flattening one level of arrays.
 */
export function pointer(value: unknown, path: string, max: number): unknown {
	if (path.length > MAX_PATH)
		throw bad(`The path is longer than ${MAX_PATH} characters`);
	if (path === '') return value;
	if (!path.startsWith('/'))
		throw bad(`The path ${quoted(path)} does not start with "/"`);
	const tokens = path
		.slice(1)
		.split('/')
		.map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
	if (tokens.length > MAX_SEGMENTS)
		throw bad(`The path has more than ${MAX_SEGMENTS} segments`);
	const found = evaluate(value, tokens, 0, max);
	if (found === FAIL)
		throw bad(`The path ${quoted(path)} names nothing in the result`);
	if (Array.isArray(found) && found.length > max) {
		throw bad(`The reference expands to more than ${max} values`);
	}
	return found;
}

function resolveOne(
	reference: unknown,
	responses: readonly Invocation[],
	budget: ReferenceBudget,
): unknown {
	if (
		!isObject(reference) ||
		typeof reference['resultOf'] !== 'string' ||
		typeof reference['name'] !== 'string' ||
		typeof reference['path'] !== 'string'
	) {
		throw bad('A ResultReference is an object of resultOf, name and path');
	}
	const { resultOf, name, path } = reference as {
		resultOf: string;
		name: string;
		path: string;
	};
	const response = responses.find(([, , id]) => id === resultOf);
	if (response === undefined) {
		throw bad(`No earlier call has the id ${quoted(resultOf)}`);
	}
	if (response[0] !== name) {
		throw bad(
			`The call ${quoted(resultOf)} answered ${quoted(response[0])}, not ${quoted(name)}`,
		);
	}
	const found = pointer(response[1], path, budget.maxItems);
	budget.left -= jsonSize(found, budget.left);
	if (budget.left < 0) {
		throw bad(
			`The references of this request resolve to more than ${budget.maxBytes} bytes`,
		);
	}
	return found;
}

/**
 * The arguments with each `#name` back-reference replaced by what it
 * points to in an earlier response of the same request. Every value
 * resolved is charged to the request's `budget`, whatever its shape, so
 * chained references cannot copy a response over and over.
 */
export function resolveReferences(
	args: Record<string, unknown>,
	responses: readonly Invocation[],
	budget: ReferenceBudget,
): Record<string, unknown> {
	if (!Object.keys(args).some((key) => key.startsWith('#'))) return args;
	const resolved: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(args)) {
		if (!key.startsWith('#')) {
			resolved[key] = value;
			continue;
		}
		const name = key.slice(1);
		if (Object.hasOwn(args, name)) {
			throw invalidArguments(
				`Both ${quoted(name)} and ${quoted(key)} are given`,
			);
		}
		resolved[name] = resolveOne(value, responses, budget);
	}
	return resolved;
}
