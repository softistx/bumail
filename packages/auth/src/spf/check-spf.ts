import { normalizeName, type Resolver } from '@bumail/dns';
import { timeoutProblem } from '../deadline';
import { AuthError } from '../errors';
import { checkHost, type Outcome } from './check';
import { explain } from './explain';
import { parseClientIp } from './ip';
import type { SpfResult } from './result';
import { Halt, type Run } from './run';

/** The SMTP session's facts SPF checks (RFC 7208 §2). */
export interface SpfInput {
	/** The client's IP address, IPv4 or IPv6; an IPv4-mapped IPv6 address is checked as IPv4. */
	readonly ip: string;
	/** The MAIL FROM address, without angle brackets; `''` (or `'<>'`) for a bounce. */
	readonly mailFrom: string;
	/** The HELO or EHLO name. */
	readonly helo: string;
}

/** What `checkSpf` is given besides the session. */
export interface CheckSpfOptions {
	/** Where records are looked up: `@bumail/dns`' resolvers, or a fixture in specs. */
	readonly resolver: Resolver;
	/**
	 * Which identity to check (§2.3, §2.4): `'mailfrom'` (the default) is
	 * the MAIL FROM domain, or `postmaster@` the HELO name for a bounce;
	 * `'helo'` is the HELO name alone.
	 */
	readonly identity?: 'mailfrom' | 'helo';
	/** Milliseconds the whole check may take; past them it is `temperror` (§4.6.4). 20 000 by default. */
	readonly timeout?: number;
	/** `%{r}` in an explanation: the receiving host's name. `unknown` by default. */
	readonly receiver?: string;
	/** The clock, in milliseconds, for `%{t}`: `Date.now` by default. */
	readonly now?: () => number;
}

function fail(message: string): never {
	throw new AuthError('INVALID_OPTION', `checkSpf(): ${message}`);
}

function checkInput(input: SpfInput, options: CheckSpfOptions): void {
	if (typeof options?.resolver?.txt !== 'function') {
		fail('resolver must be a Resolver');
	}
	for (const key of ['ip', 'mailFrom', 'helo'] as const) {
		if (typeof input?.[key] !== 'string') fail(`${key} must be a string`);
	}
	const problem = timeoutProblem(options.timeout);
	if (problem !== undefined) fail(problem);
	if (
		options.identity !== undefined &&
		options.identity !== 'mailfrom' &&
		options.identity !== 'helo'
	) {
		fail(
			`identity must be 'mailfrom' or 'helo', not ${String(options.identity)}`,
		);
	}
}

/** `<sender>` split as §4.3 reads it: an empty local-part is `postmaster`. */
function senderOf(
	input: SpfInput,
	identity: 'mailfrom' | 'helo',
): [string, string] {
	let from = input.mailFrom;
	if (from.startsWith('<') && from.endsWith('>')) from = from.slice(1, -1);
	if (identity === 'helo' || from === '') return ['postmaster', input.helo];
	const at = from.lastIndexOf('@');
	const local = at < 0 ? '' : from.slice(0, at);
	return [local === '' ? 'postmaster' : local, from.slice(at + 1)];
}

/** The domain as looked up, or `undefined` when §4.3 says `none`: malformed, or a single label. */
function domainOf(text: string): string | undefined {
	try {
		const name = normalizeName(text);
		return name.includes('.') ? name : undefined;
	} catch {
		return undefined;
	}
}

function resultOf(
	run: Run,
	domain: string,
	outcome: Outcome,
	explanation?: string,
): SpfResult {
	return {
		result: outcome.result,
		reason: outcome.reason,
		domain,
		...(outcome.mechanism === undefined
			? {}
			: { mechanism: outcome.mechanism }),
		...(explanation === undefined ? {} : { explanation }),
		lookups: run.lookups,
	};
}

/**
 * RFC 7208's check_host() for an SMTP session: whether `ip` may send mail
 * for the MAIL FROM domain (or, for a bounce or `identity: 'helo'`, the
 * HELO name). It never throws for what the DNS or a record holds: every
 * problem is a result. It throws `AuthError` only for an option or an
 * `ip` it cannot take.
 */
export async function checkSpf(
	input: SpfInput,
	options: CheckSpfOptions,
): Promise<SpfResult> {
	checkInput(input, options);
	const ip = parseClientIp(input.ip);
	if (ip === undefined)
		fail(`ip ${JSON.stringify(input.ip)} is not an IPv4 or IPv6 address`);
	const identity = options.identity ?? 'mailfrom';
	const [local, written] = senderOf(input, identity);
	const domain = domainOf(written);
	if (domain === undefined) {
		const reason = `${JSON.stringify(written)} is not a domain SPF can check`;
		return { result: 'none', reason, domain: written, lookups: 0 };
	}
	const timeout = options.timeout ?? 20_000;
	const run: Run = {
		resolver: options.resolver,
		ip,
		sender: `${local}@${domain}`,
		local,
		senderDomain: domain,
		helo: input.helo,
		receiver: options.receiver ?? 'unknown',
		now: Math.floor((options.now ?? Date.now)() / 1000),
		deadline: performance.now() + timeout,
		timeout,
		lookups: 0,
		voids: 0,
	};
	let outcome: Outcome;
	try {
		outcome = await checkHost(run, domain);
	} catch (error) {
		if (!(error instanceof Halt)) throw error;
		outcome = { result: error.result, reason: error.reason };
	}
	const explanation =
		outcome.exp === undefined ? undefined : await explain(run, outcome.exp);
	return resultOf(run, domain, outcome, explanation);
}
