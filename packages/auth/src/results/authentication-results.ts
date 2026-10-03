import { foldHeader } from '@bumail/mime';
import type { DkimResult, DkimResultWord } from '../dkim/result';
import type { DmarcResult, DmarcResultWord, SpfCheck } from '../dmarc/result';
import { AuthError } from '../errors';
import type { SpfResultWord } from '../spf/result';

/** What `formatAuthenticationResults` writes: any of the three, each left out when not checked. */
export interface AuthenticationResultsInput {
	/** What `verifyDkim` gave: one `dkim=` per signature. */
	readonly dkim?: readonly DkimResult[];
	/** What `checkSpf` gave, and for which identity: `smtp.mailfrom` or `smtp.helo`. */
	readonly spf?: SpfCheck;
	/** What `checkDmarc` gave. */
	readonly dmarc?: DmarcResult;
}

/** RFC 2045's tspecials, which a token cannot hold. */
const TSPECIALS = '()<>@,;:\\"/[]?=';
/** A longer property value is left out: no domain, selector or address is this long. */
const MAX_VALUE = 255;

/**
 * A C0 or C1 control (CR, LF and NEL among them), U+2028 or U+2029, or a
 * lone surrogate: nothing a domain, selector or base64 needs, and what a
 * reader might take for a line break.
 */
function hasControl(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
		if (code === 0x2028 || code === 0x2029) return true;
		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
			i++;
		} else if (code >= 0xdc00 && code <= 0xdfff) return true;
	}
	return false;
}

function isToken(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		const code = text.charCodeAt(i);
		if (code <= 0x20 || code >= 0x7f || TSPECIALS.includes(text[i] ?? '')) {
			return false;
		}
	}
	return text.length > 0;
}

/**
 * `value` as RFC 8601 §2.2 writes it: a token as it is, anything else as
 * a quoted-string (RFC 6532 allows UTF-8 in one). `undefined` for what no
 * value may hold: a control character (CR and LF among them), nothing at
 * all, or more than 255 characters.
 */
export function writtenValue(text: string): string | undefined {
	if (text.length === 0 || text.length > MAX_VALUE || hasControl(text)) {
		return undefined;
	}
	if (isToken(text)) return text;
	return `"${text.replace(/["\\]/g, (char) => `\\${char}`)}"`;
}

function property(name: string, value: unknown): string[] {
	const written = typeof value === 'string' ? writtenValue(value) : undefined;
	return written === undefined ? [] : [`${name}=${written}`];
}

const DKIM: readonly DkimResultWord[] = [
	'pass',
	'fail',
	'neutral',
	'temperror',
	'permerror',
	'policy',
	'none',
];
const SPF: readonly SpfResultWord[] = [
	'none',
	'neutral',
	'pass',
	'fail',
	'softfail',
	'temperror',
	'permerror',
];
const DMARC: readonly DmarcResultWord[] = [
	'pass',
	'fail',
	'none',
	'temperror',
	'permerror',
];

function fail(message: string): never {
	throw new AuthError(
		'INVALID_OPTION',
		`formatAuthenticationResults(): ${message}`,
	);
}

function method(name: string, words: readonly string[], word: unknown): string {
	if (typeof word !== 'string' || !words.includes(word)) {
		fail(
			`${name} result ${JSON.stringify(word)} is not one of ${words.join('|')}`,
		);
	}
	return `${name}=${word}`;
}

function resinfos(results: AuthenticationResultsInput): string[] {
	const written: string[] = [];
	for (const dkim of results.dkim ?? []) {
		written.push(
			[
				method('dkim', DKIM, dkim?.result),
				...property('header.d', dkim.domain),
				...property('header.s', dkim.selector),
				...property('header.b', dkim.signature?.slice(0, 8)),
			].join(' '),
		);
	}
	const { spf, dmarc } = results;
	if (spf !== undefined) {
		const identity = spf?.identity === 'helo' ? 'smtp.helo' : 'smtp.mailfrom';
		written.push(
			[
				method('spf', SPF, spf?.result?.result),
				...property(identity, spf.result.domain),
			].join(' '),
		);
	}
	if (dmarc !== undefined) {
		written.push(
			[
				method('dmarc', DMARC, dmarc?.result),
				...property('header.from', dmarc.domain),
			].join(' '),
		);
	}
	return written;
}

/**
 * The `Authentication-Results` field (RFC 8601) for what this receiver
 * checked, folded at 78 columns by `@bumail/mime`, CRLF included: prepend
 * it to the message. With nothing checked, it says `none`.
 *
 * `authservId` names this receiver, usually its host name. Every property
 * value is a token or a quoted-string: none can end a result with `;` or
 * add a line. One holding a control character, or that is not a string,
 * is left out.
 */
export function formatAuthenticationResults(
	authservId: string,
	results: AuthenticationResultsInput,
): string {
	const id =
		typeof authservId === 'string' ? writtenValue(authservId) : undefined;
	if (id === undefined) {
		fail(
			'authservId must be 1 to 255 characters with no control character, such as the host name',
		);
	}
	if (typeof results !== 'object' || results === null) {
		fail('results must be an object of dkim, spf and dmarc');
	}
	if (results.dkim !== undefined && !Array.isArray(results.dkim)) {
		fail('dkim must be the array verifyDkim returned');
	}
	const written = resinfos(results);
	const payload = written.length === 0 ? ['none'] : written;
	return `${foldHeader('Authentication-Results', `${id}; ${payload.join('; ')}`)}\r\n`;
}
