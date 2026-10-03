import { lowerAscii } from '../text';

/**
 * The names a signature carries, checked the same way by the verifier and
 * the signer. Both expressions run in linear time: every label is bounded,
 * and nothing nested can match the same text two ways.
 */

/** A domain or a selector: dot-separated labels of letters, digits, `_` and inner `-`, 253 characters at most. */
export const DNS_NAME =
	/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/i;

/**
 * A header field name as `h=` lists it: printable ASCII but `:` (RFC 5322
 * §3.6.8) and `;`, which would end the tag. No white space, no control
 * character, nothing outside ASCII.
 */
export const FIELD_NAME = /^[\x21-\x39\x3c-\x7e]+$/;

/**
 * The domain of an `i=` identity, lower-cased, or why it is refused: no
 * `@` or a domain that is not a name (`malformed`), or one outside `d=`
 * (`outside`). `domain` is `d=`, already lower-cased.
 */
export function identityDomain(
	identity: string,
	domain: string,
): string | 'malformed' | 'outside' {
	const at = identity.lastIndexOf('@');
	const of = lowerAscii(identity.slice(at + 1));
	if (at < 0 || !DNS_NAME.test(of)) return 'malformed';
	if (of !== domain && !of.endsWith(`.${domain}`)) return 'outside';
	return of;
}
