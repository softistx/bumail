import type { Resolver } from '@bumail/dns';
import { AuthError } from '../errors';
import { type BodyDigest, BodyHasher } from './body';
import {
	describe,
	finish,
	type Pending,
	type Settings,
	screen,
} from './evaluate';
import { type RawField, splitFields } from './headers';
import { fetchKey } from './key';
import {
	HeaderTooLarge,
	type MessageInput,
	type SplitMessage,
	splitMessage,
} from './message';
import type { DkimResult, Verdict } from './result';
import { parseSignature } from './signature';

/** What `verifyDkim` is given besides the message. */
export interface VerifyDkimOptions {
	/** Where key records are looked up: `@bumail/dns`' resolvers, or a fixture in specs. */
	readonly resolver: Resolver;
	/** The clock, in milliseconds: `Date.now` by default. */
	readonly now?: () => number;
	/** Seconds `t=` may be ahead and `x=` behind the clock. 300 by default. */
	readonly clockSkew?: number;
	/** Bytes the header may take; past them the message gives one `policy`. 256 KiB by default. */
	readonly maxHeaderBytes?: number;
	/** Signatures checked at most; the rest come back as `policy`. 10 by default. */
	readonly maxSignatures?: number;
	/** Entries `h=` may list; a longer one is `policy`. 64 by default. */
	readonly maxSignedHeaders?: number;
	/** RSA keys shorter than this are `policy` (under 1024 is always `permerror`). 1024 by default. */
	readonly minRsaBits?: number;
	/** Refuses any signature with `l=` as `policy`. `false` by default: `l=` is honoured and reported. */
	readonly rejectBodyLength?: boolean;
}

function count(
	name: string,
	value: number | undefined,
	fallback: number,
	least: number,
): number {
	const n = value ?? fallback;
	if (!Number.isSafeInteger(n) || n < least) {
		throw new AuthError(
			'INVALID_OPTION',
			`verifyDkim(): ${name} must be an integer of at least ${least}, not ${String(value)}`,
		);
	}
	return n;
}

function settingsOf(options: VerifyDkimOptions): Settings {
	if (typeof options?.resolver?.txt !== 'function') {
		throw new AuthError(
			'INVALID_OPTION',
			'verifyDkim(): resolver must be a Resolver',
		);
	}
	return {
		resolver: options.resolver,
		now: Math.floor((options.now ?? Date.now)() / 1000),
		clockSkew: count('clockSkew', options.clockSkew, 300, 0),
		maxHeaderBytes: count('maxHeaderBytes', options.maxHeaderBytes, 262_144, 1),
		maxSignatures: count('maxSignatures', options.maxSignatures, 10, 1),
		maxSignedHeaders: count(
			'maxSignedHeaders',
			options.maxSignedHeaders,
			64,
			1,
		),
		minRsaBits: count('minRsaBits', options.minRsaBits, 1024, 1024),
		rejectBodyLength: options.rejectBodyLength ?? false,
	};
}

type Planned = { readonly result: DkimResult; readonly pending?: Pending };

function plan(
	field: RawField,
	index: number,
	settings: Settings,
	froms: number,
): Planned {
	if (index >= settings.maxSignatures) {
		return {
			result: {
				result: 'policy',
				reason: `more than ${settings.maxSignatures} signatures (maxSignatures)`,
				testing: false,
			},
		};
	}
	const parsed = parseSignature(field.raw, settings.maxSignedHeaders);
	const base = describe(
		parsed.tags,
		'signature' in parsed ? parsed.signature : undefined,
	);
	const refused = screen(parsed, settings, froms);
	if (refused !== undefined || !('signature' in parsed)) {
		return { result: { ...base, ...(refused as Verdict) } };
	}
	const { signature } = parsed;
	const key = fetchKey(
		settings.resolver,
		signature.selector,
		signature.domain,
		signature.algorithm,
	);
	return { result: base, pending: { field, signature, key } };
}

function bodyKey(pending: Pending): string {
	return `${pending.signature.bodyCanon}/${pending.signature.bodyLength ?? ''}`;
}

/** Streams the body once through one hasher per canonicalisation and `l=` the signatures ask for. */
async function hashBody(
	split: SplitMessage,
	pendings: readonly Pending[],
): Promise<Map<string, BodyDigest>> {
	const hashers = new Map<string, BodyHasher>();
	for (const pending of pendings) {
		const { bodyCanon, bodyLength } = pending.signature;
		if (!hashers.has(bodyKey(pending))) {
			hashers.set(bodyKey(pending), new BodyHasher(bodyCanon, bodyLength));
		}
	}
	if (hashers.size === 0) {
		await split.cancel();
		return new Map();
	}
	for await (const chunk of split.body) {
		for (const hasher of hashers.values()) hasher.write(chunk);
	}
	return new Map([...hashers].map(([key, hasher]) => [key, hasher.end()]));
}

function unreadable(
	reason: string,
	result: 'policy' | 'temperror',
): DkimResult[] {
	return [{ result, reason, testing: false }];
}

/**
 * Checks every DKIM-Signature on a message (RFC 6376 §6) and gives one
 * result per signature, in the order they appear, in RFC 8601's words.
 * A message with none gives one `none` result. It never throws for what a
 * message holds — only for an option it cannot take (`AuthError`).
 *
 * The body is streamed once and hashed with bounded memory; key lookups
 * run while it streams.
 */
export async function verifyDkim(
	message: MessageInput,
	options: VerifyDkimOptions,
): Promise<DkimResult[]> {
	const settings = settingsOf(options);
	let split: SplitMessage;
	try {
		split = await splitMessage(message, settings.maxHeaderBytes);
	} catch (error) {
		if (error instanceof HeaderTooLarge) {
			return unreadable(
				`the header is larger than maxHeaderBytes (${settings.maxHeaderBytes})`,
				'policy',
			);
		}
		return unreadable(
			`the message could not be read: ${String(error)}`,
			'temperror',
		);
	}
	const fields = splitFields(split.header);
	const signatures = fields.filter((field) => field.name === 'dkim-signature');
	if (signatures.length === 0) {
		await split.cancel();
		return [
			{ result: 'none', reason: 'no DKIM-Signature header', testing: false },
		];
	}
	const froms = fields.filter((field) => field.name === 'from').length;
	const planned = signatures.map((field, i) => plan(field, i, settings, froms));
	const pendings = planned.flatMap((p) =>
		p.pending === undefined ? [] : [p.pending],
	);
	let digests: Map<string, BodyDigest>;
	try {
		digests = await hashBody(split, pendings);
	} catch (error) {
		await Promise.all(pendings.map((p) => p.key));
		const reason = `the message could not be read: ${String(error)}`;
		return planned.map((p) =>
			p.pending === undefined
				? p.result
				: { ...p.result, result: 'temperror', reason },
		);
	}
	return Promise.all(
		planned.map(async ({ result, pending }) => {
			if (pending === undefined) return result;
			const digest = digests.get(bodyKey(pending)) as BodyDigest;
			const done = await finish(pending, digest, fields, settings);
			const { verdict, ...rest } = done;
			return {
				...result,
				...rest,
				result: verdict?.result ?? 'pass',
				...(verdict ? { reason: verdict.reason } : {}),
			};
		}),
	);
}
