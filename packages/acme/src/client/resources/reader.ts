import { isArray } from '../../encoding';
import { AcmeError } from '../../errors';
import { identifierOf } from '../problem';
import type { AcmeIdentifier } from '../types';
import { serverUrl } from '../urls';

/** The most authorizations an order may list, and challenges an authorization: far above any CA's. */
export const MAX_ITEMS = 1000;

/** An identifier from the CA, its type 64 characters at most and its value 256; undefined otherwise. */
export function boundedIdentifier(value: unknown): AcmeIdentifier | undefined {
	const identifier = identifierOf(value);
	return identifier !== undefined &&
		identifier.type.length <= 64 &&
		identifier.value.length <= 256
		? identifier
		: undefined;
}

/** Reads the members of one resource, naming the member that is wrong. */
export class Reader {
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
		const identifier = boundedIdentifier(this.value[member]);
		if (identifier === undefined) throw this.bad(member);
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
