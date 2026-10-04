import { isBase64url } from '../../encoding';
import { AcmeError } from '../../errors';
import { isObject } from '../body';
import { problemOf } from '../problem';
import type {
	AcmeAuthorization,
	AcmeAuthorizationStatus,
	AcmeChallenge,
	AcmeChallengeStatus,
} from '../types';
import { Reader } from './reader';

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
	if (token !== undefined) {
		// a token is base64url (RFC 8555 §8.1): another one is the CA's fault
		if (!isBase64url(token)) throw read.bad('token');
		challenge.token = token;
	}
	const validated = read.optionalString('validated');
	if (validated !== undefined) challenge.validated = validated;
	const error = problemOf(value['error']);
	if (error !== undefined) challenge.error = error;
	return challenge;
}
