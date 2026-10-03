import type { DkimResult } from '../dkim/result';
import type { SpfCheck } from './result';

/** The organizational domain of a name, or the name itself when it is a public suffix. */
export type OrgOf = (domain: string) => string;

/**
 * Identifier alignment (RFC 7489 §3.1). Strict is an exact match; relaxed
 * is the same organizational domain. A public suffix is its own
 * organizational domain here, so `d=com` aligns with no `example.com`
 * (§3.1.1), and `example.com` with no `com`.
 */
export function isAligned(
	authenticated: string,
	from: string,
	mode: 'r' | 's',
	orgOf: OrgOf,
): boolean {
	if (authenticated === from) return true;
	return mode === 'r' && orgOf(authenticated) === orgOf(from);
}

/** What the authenticated identifiers say about the From domain. */
export interface Alignment {
	/** `d=` of the first passing DKIM signature aligned with From. */
	readonly dkim?: string;
	/** The SPF domain, when it passed and is aligned with From. */
	readonly spf?: string;
	/** No aligned pass, and an aligned check failed for a temporary error (§6.6.2). */
	readonly temporary: boolean;
}

/**
 * Aligns every DKIM result and the SPF result with `from`. A temporary
 * error counts only on an aligned identifier: a forger who signs with a
 * domain whose DNS they make time out must not turn `fail` into
 * `temperror`.
 */
export function align(
	from: string,
	dkim: readonly DkimResult[],
	spf: SpfCheck | undefined,
	modes: { readonly adkim: 'r' | 's'; readonly aspf: 'r' | 's' },
	orgOf: OrgOf,
): Alignment {
	let passed: string | undefined;
	let temporary = false;
	for (const signature of dkim) {
		const domain = signature.domain;
		if (domain === undefined) continue;
		if (!isAligned(domain, from, modes.adkim, orgOf)) continue;
		if (signature.result === 'pass') passed ??= domain;
		if (signature.result === 'temperror') temporary = true;
	}
	let spfPassed: string | undefined;
	if (spf?.identity === 'mailfrom') {
		const { result, domain } = spf.result;
		if (isAligned(domain, from, modes.aspf, orgOf)) {
			if (result === 'pass') spfPassed = domain;
			if (result === 'temperror') temporary = true;
		}
	}
	return {
		...(passed === undefined ? {} : { dkim: passed }),
		...(spfPassed === undefined ? {} : { spf: spfPassed }),
		temporary: temporary && passed === undefined && spfPassed === undefined,
	};
}
