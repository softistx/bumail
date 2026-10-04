import { isArray, shown } from '../encoding';
import { AcmeError } from '../errors';
import {
	describeProblem,
	identifierOf,
	isObject,
	printable,
	problemOf,
	serverUrl,
} from './http';
import type {
	AcmeAuthorization,
	AcmeAuthorizationStatus,
	AcmeChallenge,
	AcmeChallengeStatus,
	AcmeDirectory,
	AcmeDirectoryMeta,
	AcmeIdentifier,
	AcmeOrder,
	AcmeOrderStatus,
} from './types';

/** The most authorizations an order may list, and challenges an authorization: far above any CA's. */
const MAX_ITEMS = 1000;

const ORDER_STATUSES: readonly AcmeOrderStatus[] = [
	'pending',
	'ready',
	'processing',
	'valid',
	'invalid',
];
const AUTHORIZATION_STATUSES: readonly AcmeAuthorizationStatus[] = [
	'pending',
	'valid',
	'invalid',
	'deactivated',
	'expired',
	'revoked',
];
const CHALLENGE_STATUSES: readonly AcmeChallengeStatus[] = [
	'pending',
	'processing',
	'valid',
	'invalid',
];

/** Reads the members of one resource, naming the member that is wrong. */
class Reader {
	constructor(
		private readonly value: Record<string, unknown>,
		private readonly what: string,
		private readonly where: string,
		private readonly allowInsecure: boolean,
	) {}

	bad(member: string): AcmeError {
		return new AcmeError(
			'BAD_RESPONSE',
			`${this.where}: the CA's ${this.what} has a missing or invalid "${member}"`,
		);
	}

	url(member: string): string {
		return serverUrl(
			this.value[member],
			`${this.what} "${member}"`,
			this.where,
			this.allowInsecure,
		);
	}

	optionalUrl(member: string): string | undefined {
		return this.value[member] === undefined ? undefined : this.url(member);
	}

	status<T extends string>(allowed: readonly T[]): T {
		const value = this.value['status'];
		if (!(allowed as readonly unknown[]).includes(value)) {
			throw this.bad('status');
		}
		return value as T;
	}

	/** A string member kept as given, bounded: dates, mostly. */
	optionalString(member: string): string | undefined {
		const value = this.value[member];
		if (value === undefined) return undefined;
		if (typeof value !== 'string' || value.length > 256) {
			throw this.bad(member);
		}
		return value;
	}

	identifier(member: string): AcmeIdentifier {
		const identifier = identifierOf(this.value[member]);
		if (
			identifier === undefined ||
			identifier.type.length > 64 ||
			identifier.value.length > 256
		) {
			throw this.bad(member);
		}
		return identifier;
	}

	array(member: string): unknown[] {
		const value = this.value[member];
		if (!isArray(value) || (value as unknown[]).length > MAX_ITEMS) {
			throw this.bad(member);
		}
		return value as unknown[];
	}
}

/** The directory (RFC 8555 §7.1.1), its URLs checked. */
export function directoryOf(
	value: unknown,
	where: string,
	allowInsecure: boolean,
): AcmeDirectory {
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's directory is not a JSON object`,
		);
	}
	const read = new Reader(value, 'directory', where, allowInsecure);
	const directory: AcmeDirectory = {
		newNonce: read.url('newNonce'),
		newAccount: read.url('newAccount'),
		newOrder: read.url('newOrder'),
	};
	for (const member of [
		'revokeCert',
		'keyChange',
		'newAuthz',
		'renewalInfo',
	] as const) {
		const url = read.optionalUrl(member);
		if (url !== undefined) directory[member] = url;
	}
	const meta = metaOf(value['meta']);
	if (meta !== undefined) directory.meta = meta;
	return directory;
}

/** The directory's `meta`, keeping the members of the right type and dropping the rest. */
function metaOf(value: unknown): AcmeDirectoryMeta | undefined {
	if (!isObject(value)) return undefined;
	const meta: AcmeDirectoryMeta = {};
	const text = (member: string) => {
		const item = value[member];
		return typeof item === 'string' && item.length <= 2048 ? item : undefined;
	};
	const terms = text('termsOfService');
	if (terms !== undefined) meta.termsOfService = terms;
	const website = text('website');
	if (website !== undefined) meta.website = website;
	const caa = value['caaIdentities'];
	if (isArray(caa)) {
		meta.caaIdentities = (caa as unknown[])
			.filter((item): item is string => typeof item === 'string')
			.slice(0, 100)
			.map((item) => printable(item, 256));
	}
	if (typeof value['externalAccountRequired'] === 'boolean') {
		meta.externalAccountRequired = value['externalAccountRequired'];
	}
	const profiles = value['profiles'];
	if (isObject(profiles)) {
		meta.profiles = Object.fromEntries(
			Object.entries(profiles)
				.filter(
					(entry): entry is [string, string] => typeof entry[1] === 'string',
				)
				.slice(0, 100)
				.map(([name, text]) => [printable(name, 64), printable(text, 512)]),
		);
	}
	return meta;
}

/** An order (RFC 8555 §7.1.3) at `url`, its URLs checked. */
export function orderOf(
	value: unknown,
	url: string,
	where: string,
	allowInsecure: boolean,
): AcmeOrder {
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's order is not a JSON object`,
		);
	}
	const read = new Reader(value, 'order', where, allowInsecure);
	const identifiers = read.array('identifiers').map((item) => {
		const identifier = identifierOf(item);
		if (identifier === undefined) throw read.bad('identifiers');
		return identifier;
	});
	const authorizations = read
		.array('authorizations')
		.map((item) =>
			serverUrl(item, 'order "authorizations"', where, allowInsecure),
		);
	const order: AcmeOrder = {
		url,
		status: read.status(ORDER_STATUSES),
		identifiers,
		authorizations,
		finalize: read.url('finalize'),
	};
	const certificate = read.optionalUrl('certificate');
	if (certificate !== undefined) order.certificate = certificate;
	for (const member of ['expires', 'notBefore', 'notAfter'] as const) {
		const text = read.optionalString(member);
		if (text !== undefined) order[member] = text;
	}
	const error = problemOf(value['error']);
	if (error !== undefined) order.error = error;
	return order;
}

/** An authorization (RFC 8555 §7.1.4) at `url`, its challenges read. */
export function authorizationOf(
	value: unknown,
	url: string,
	where: string,
	allowInsecure: boolean,
): AcmeAuthorization {
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's authorization is not a JSON object`,
		);
	}
	const read = new Reader(value, 'authorization', where, allowInsecure);
	const authorization: AcmeAuthorization = {
		url,
		status: read.status(AUTHORIZATION_STATUSES),
		identifier: read.identifier('identifier'),
		challenges: read
			.array('challenges')
			.map((item) => challengeOf(item, where, allowInsecure)),
	};
	const expires = read.optionalString('expires');
	if (expires !== undefined) authorization.expires = expires;
	if (typeof value['wildcard'] === 'boolean') {
		authorization.wildcard = value['wildcard'];
	}
	return authorization;
}

/** A challenge (RFC 8555 §8), its URL checked; its token is checked where it is used. */
export function challengeOf(
	value: unknown,
	where: string,
	allowInsecure: boolean,
): AcmeChallenge {
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's challenge is not a JSON object`,
		);
	}
	const read = new Reader(value, 'challenge', where, allowInsecure);
	const type = value['type'];
	if (typeof type !== 'string' || type.length > 64) throw read.bad('type');
	const challenge: AcmeChallenge = {
		type,
		url: read.url('url'),
		status: read.status(CHALLENGE_STATUSES),
	};
	const token = read.optionalString('token');
	if (token !== undefined) challenge.token = token;
	const validated = read.optionalString('validated');
	if (validated !== undefined) challenge.validated = validated;
	const error = problemOf(value['error']);
	if (error !== undefined) challenge.error = error;
	return challenge;
}

/** `AUTHORIZATION_FAILED` for an authorization that ended other than `valid`, with its failed challenge's problem. */
export function authorizationFailed(
	where: string,
	authorization: AcmeAuthorization,
): AcmeError {
	const problem = authorization.challenges.find(
		(challenge) => challenge.error !== undefined,
	)?.error;
	return new AcmeError(
		'AUTHORIZATION_FAILED',
		`${where}: the authorization for ${shown(authorization.identifier.value)} is "${authorization.status}"${problem ? `: ${describeProblem(problem)}` : ''}`,
		problem === undefined ? {} : { problem },
	);
}

/** `ORDER_FAILED` for an `invalid` order, with its problem. */
export function orderFailed(where: string, order: AcmeOrder): AcmeError {
	return new AcmeError(
		'ORDER_FAILED',
		`${where}: the order is "invalid"${order.error ? `: ${describeProblem(order.error)}` : ''}`,
		order.error === undefined ? {} : { problem: order.error },
	);
}
