import type { Limits } from '../server/settings';
import { cut, quoted } from '../shared/text';
import { jsonExcess } from './json';

export const CORE = 'urn:ietf:params:jmap:core';
export const MAIL = 'urn:ietf:params:jmap:mail';
/** The capabilities this server knows, for `using`. */
export const CAPABILITIES: readonly string[] = [CORE, MAIL];

export type Invocation = [string, Record<string, unknown>, string];

/** A JMAP Request (RFC 8620 §3.3), checked. */
export interface JmapRequest {
	readonly using: readonly string[];
	readonly methodCalls: readonly Invocation[];
	readonly createdIds?: Readonly<Record<string, string>>;
}

/** A request refused as a whole (RFC 8620 §3.6.1). */
export interface Refused {
	readonly type: 'notJSON' | 'notRequest' | 'unknownCapability' | 'limit';
	readonly detail: string;
	readonly limit?: string;
}

/** The longest method name or call id taken: nothing a client sends is held unbounded. */
const MAX_NAME = 255;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const isName = (value: unknown): value is string =>
	typeof value === 'string' && value.length > 0 && value.length <= MAX_NAME;

/** Bytes to JSON, refused before parsing when they nest too deep or hold too much. */
export function parseJson(
	bytes: Uint8Array,
	limits: Limits,
): { ok: true; value: unknown } | { ok: false; refused: Refused } {
	let text: string;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		return notJson('The request body is not UTF-8');
	}
	const excess = jsonExcess(text, limits.maxJsonDepth, limits.maxJsonTokens);
	if (excess === 'depth') {
		return limit(
			'maxJsonDepth',
			`The JSON nests deeper than ${limits.maxJsonDepth} levels`,
		);
	}
	if (excess === 'tokens') {
		return limit(
			'maxJsonTokens',
			`The JSON holds more than ${limits.maxJsonTokens} tokens`,
		);
	}
	try {
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return notJson('The request body is not JSON');
	}
}

function notJson(detail: string) {
	return { ok: false as const, refused: { type: 'notJSON' as const, detail } };
}

function limit(name: string, detail: string) {
	return {
		ok: false as const,
		refused: { type: 'limit' as const, limit: name, detail },
	};
}

function notRequest(detail: string) {
	return {
		ok: false as const,
		refused: { type: 'notRequest' as const, detail },
	};
}

function invocationProblem(call: unknown, index: number): string | undefined {
	if (!Array.isArray(call) || call.length !== 3) {
		return `methodCalls[${index}] is not an array of a name, arguments and a call id`;
	}
	const [name, args, id] = call as unknown[];
	if (!isName(name))
		return `methodCalls[${index}] has no method name of 1 to ${MAX_NAME} characters`;
	if (!isObject(args))
		return `methodCalls[${index}]'s arguments are not an object`;
	if (typeof id !== 'string' || id.length > MAX_NAME) {
		return `methodCalls[${index}] has no call id of at most ${MAX_NAME} characters`;
	}
	return undefined;
}

function createdIdsProblem(value: unknown, limits: Limits): string | undefined {
	if (value === undefined) return undefined;
	if (!isObject(value)) return 'createdIds is not an object';
	const entries = Object.entries(value);
	if (entries.length > limits.maxObjectsInSet) {
		return `createdIds holds more than ${limits.maxObjectsInSet} ids`;
	}
	for (const [key, id] of entries) {
		if (!isName(key) || typeof id !== 'string' || id.length > MAX_NAME) {
			return `createdIds[${quoted(key)}] is not a creation id and an id`;
		}
	}
	return undefined;
}

/** A parsed body as a JMAP Request, or why it is not one. */
export function checkRequest(
	value: unknown,
	limits: Limits,
): { ok: true; request: JmapRequest } | { ok: false; refused: Refused } {
	if (!isObject(value)) return notRequest('The request is not a JSON object');
	const { using, methodCalls, createdIds } = value;
	if (!Array.isArray(using) || !using.every(isName) || using.length > 64) {
		return notRequest('using is not an array of capability names');
	}
	if (!Array.isArray(methodCalls)) {
		return notRequest('methodCalls is not an array');
	}
	if (methodCalls.length > limits.maxCallsInRequest) {
		return limit(
			'maxCallsInRequest',
			`The request makes more than ${limits.maxCallsInRequest} method calls`,
		);
	}
	const problem =
		methodCalls.map(invocationProblem).find((p) => p !== undefined) ??
		createdIdsProblem(createdIds, limits);
	if (problem !== undefined) return notRequest(problem);
	const unknown = using.find((name) => !CAPABILITIES.includes(name));
	if (unknown !== undefined) {
		return {
			ok: false,
			refused: {
				type: 'unknownCapability',
				detail: `The server does not support the capability "${cut(unknown)}"`,
			},
		};
	}
	return {
		ok: true,
		request: {
			using,
			methodCalls: methodCalls as Invocation[],
			...(createdIds === undefined
				? {}
				: { createdIds: createdIds as Record<string, string> }),
		},
	};
}
