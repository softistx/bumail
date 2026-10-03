import type { Resolver } from '@bumail/dns';
import { timeoutProblem } from '../deadline';
import type { MessageInput } from '../dkim/message';
import type { DkimResult } from '../dkim/result';
import { AuthError } from '../errors';
import { lowerAscii } from '../text';
import { type Alignment, align, type OrgOf } from './align';
import { authorOf } from './author';
import { discover } from './discover';
import { organizationalDomain } from './psl';
import type { DmarcPolicy, DmarcResult, SpfCheck } from './result';

/** What DMARC evaluates: the message's From, and what DKIM and SPF said. */
export interface DmarcInput {
	/** The message, as given to `verifyDkim`: only its header is read, for From. */
	readonly message: MessageInput;
	/** What `verifyDkim` gave for the same message. */
	readonly dkim: readonly DkimResult[];
	/** What `checkSpf` gave for the session, and for which identity; leave it out when SPF was not checked. */
	readonly spf?: SpfCheck;
}

/** What `checkDmarc` is given besides the input. */
export interface CheckDmarcOptions {
	/** Where records are looked up: `@bumail/dns`' resolvers, or a fixture in specs. */
	readonly resolver: Resolver;
	/**
	 * The organizational domain of a name (RFC 7489 §3.2), `undefined` for a
	 * public suffix. The Public Suffix List snapshot this package embeds
	 * by default; pass your own to use a fresher list.
	 */
	readonly organizationalDomain?: (domain: string) => string | undefined;
	/** A number in [0, 1), drawn to apply `pct` (§6.6.4): `Math.random` by default. */
	readonly random?: () => number;
	/** Milliseconds the record lookups may take; past them it is `temperror`. 20 000 by default. */
	readonly timeout?: number;
	/** Bytes the header may take; past them the From cannot be read (`permerror`). 256 KiB by default. */
	readonly maxHeaderBytes?: number;
}

function fail(message: string): never {
	throw new AuthError('INVALID_OPTION', `checkDmarc(): ${message}`);
}

function isMessage(message: unknown): boolean {
	return (
		typeof message === 'string' ||
		message instanceof Uint8Array ||
		message instanceof ReadableStream
	);
}

/** An entry `verifyDkim` could have given: a result word, and a domain if any, both strings. */
function isDkimResult(entry: unknown): boolean {
	if (typeof entry !== 'object' || entry === null) return false;
	const { result, domain } = entry as Partial<DkimResult>;
	return (
		typeof result === 'string' &&
		(domain === undefined || typeof domain === 'string')
	);
}

function checkSpfInput(spf: SpfCheck | undefined): void {
	if (spf === undefined) return;
	if (
		typeof spf?.result?.result !== 'string' ||
		typeof spf.result.domain !== 'string'
	) {
		fail('spf.result must be what checkSpf returned');
	}
	if (spf.identity !== 'mailfrom' && spf.identity !== 'helo') {
		fail(
			`spf.identity must be 'mailfrom' or 'helo', not ${String(spf.identity)}`,
		);
	}
}

function checkInput(input: DmarcInput, options: CheckDmarcOptions): void {
	if (typeof options?.resolver?.txt !== 'function') {
		fail('resolver must be a Resolver');
	}
	if (!isMessage(input?.message)) {
		fail('message must be a Uint8Array, a string or a ReadableStream');
	}
	if (!Array.isArray(input.dkim) || !input.dkim.every(isDkimResult)) {
		fail('dkim must be the array verifyDkim returned');
	}
	checkSpfInput(input.spf);
	for (const key of ['organizationalDomain', 'random'] as const) {
		const value = options[key];
		if (value !== undefined && typeof value !== 'function') {
			fail(`${key} must be a function`);
		}
	}
	const problem = timeoutProblem(options.timeout);
	if (problem !== undefined) fail(problem);
	const max = options.maxHeaderBytes;
	if (max !== undefined && !(Number.isSafeInteger(max) && max >= 1)) {
		fail(`maxHeaderBytes must be an integer of at least 1, not ${String(max)}`);
	}
}

/**
 * The organizational domain, each name worked out once. A public suffix
 * stands for itself, and so does a name whose answer is not the name or
 * one of its parents: a caller's function cannot send the lookup to
 * another domain's policy.
 */
function orgOfFrom(options: CheckDmarcOptions): OrgOf {
	const find = options.organizationalDomain ?? organizationalDomain;
	const known = new Map<string, string>();
	return (domain) => {
		let org = known.get(domain);
		if (org === undefined) {
			const found = find(domain);
			const lower = typeof found === 'string' ? lowerAscii(found) : '';
			const parent = lower === domain || domain.endsWith(`.${lower}`);
			org = lower !== '' && parent ? lower : domain;
			known.set(domain, org);
		}
		return org;
	};
}

/** Whether `pct` selects this message (§6.6.4). */
function sample(pct: number, random: () => number): boolean {
	if (pct >= 100) return true;
	if (pct <= 0) return false;
	return random() * 100 < pct;
}

/** What a failing message gets: the policy when sampled, one step milder when not (§6.6.4). */
function dispositionOf(policy: DmarcPolicy, sampled: boolean): DmarcPolicy {
	if (sampled) return policy;
	return policy === 'reject' ? 'quarantine' : 'none';
}

function verdict(alignment: Alignment): Pick<DmarcResult, 'result' | 'reason'> {
	if (alignment.dkim !== undefined) {
		return {
			result: 'pass',
			reason: `aligned DKIM pass for d=${alignment.dkim}`,
		};
	}
	if (alignment.spf !== undefined) {
		return { result: 'pass', reason: `aligned SPF pass for ${alignment.spf}` };
	}
	if (alignment.temporary) {
		return {
			result: 'temperror',
			reason: 'an aligned DKIM or SPF check had a temporary error',
		};
	}
	return { result: 'fail', reason: 'no aligned DKIM or SPF pass' };
}

/**
 * DMARC (RFC 7489) for a received message: the From domain's policy,
 * found at `_dmarc.<From domain>` or else at its organizational domain,
 * and whether a passing DKIM signature or SPF check is aligned with From.
 * `disposition` is what the policy asks for this message. It never throws
 * for what the message, the DNS or a record holds: every problem is a
 * result. It throws `AuthError` only for an input or option it cannot
 * take. No report is sent.
 */
export async function checkDmarc(
	input: DmarcInput,
	options: CheckDmarcOptions,
): Promise<DmarcResult> {
	checkInput(input, options);
	const author = await authorOf(
		input.message,
		options.maxHeaderBytes ?? 262_144,
	);
	if (!('domain' in author)) {
		const disposition = author.result === 'permerror' ? 'reject' : 'none';
		return {
			...author,
			domain: '',
			policy: 'none',
			disposition,
			sampled: false,
		};
	}
	const { domain } = author;
	const orgOf = orgOfFrom(options);
	const timeout = options.timeout ?? 20_000;
	const lookup = {
		resolver: options.resolver,
		deadline: performance.now() + timeout,
		timeout,
	};
	const found = await discover(lookup, domain, orgOf(domain));
	if (!('record' in found)) {
		return {
			...found,
			domain,
			policy: 'none',
			disposition: 'none',
			sampled: false,
		};
	}
	const { record, policyDomain, policy } = found;
	const alignment = align(domain, input.dkim, input.spf, record, orgOf);
	const sampled = sample(record.pct, options.random ?? Math.random);
	const { result, reason } = verdict(alignment);
	return {
		result,
		reason,
		domain,
		policyDomain,
		policy,
		disposition: result === 'fail' ? dispositionOf(policy, sampled) : 'none',
		...(alignment.dkim === undefined ? {} : { alignedDkim: alignment.dkim }),
		...(alignment.spf === undefined ? {} : { alignedSpf: alignment.spf }),
		sampled,
		record,
	};
}
