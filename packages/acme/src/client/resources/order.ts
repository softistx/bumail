import { AcmeError } from '../../errors';
import { isObject } from '../body';
import { problemOf } from '../problem';
import type { AcmeOrder, AcmeOrderStatus } from '../types';
import { serverUrl } from '../urls';
import { boundedIdentifier, Reader } from './reader';

const ORDER_STATUSES: readonly AcmeOrderStatus[] = [
	'pending',
	'ready',
	'processing',
	'valid',
	'invalid',
];

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
		const identifier = boundedIdentifier(item);
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
