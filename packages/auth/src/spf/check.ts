import { targetName } from './expand';
import type { MacroString } from './macro';
import { matches } from './mechanisms';
import {
	isSpfRecord,
	parseRecord,
	type Qualifier,
	type SpfRecord,
} from './record';
import type { SpfResultWord } from './result';
import { countLookup, Halt, lookUp, type Run } from './run';

/** What one check_host() came to, with what the explanation needs when it is `fail`. */
export interface Outcome {
	readonly result: SpfResultWord;
	readonly reason: string;
	readonly mechanism?: string;
	/** The `exp=` of the record whose mechanism gave `fail`, and that record's domain. */
	readonly exp?: { readonly spec: MacroString; readonly domain: string };
}

const WORDS: Readonly<Record<Qualifier, SpfResultWord>> = {
	'+': 'pass',
	'-': 'fail',
	'~': 'softfail',
	'?': 'neutral',
};

function isAscii(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) > 0x7f) return false;
	}
	return true;
}

/** The domain's one SPF record (§4.5), or the outcome when there is none, or more than one. */
async function recordOf(
	run: Run,
	domain: string,
): Promise<SpfRecord | Outcome> {
	const texts = (await lookUp(run, 'txt', domain))
		.map((record) => record.text)
		.filter(isSpfRecord);
	if (texts.length === 0) {
		return { result: 'none', reason: `no SPF record at ${domain}` };
	}
	if (texts.length > 1) {
		return {
			result: 'permerror',
			reason: `more than one SPF record at ${domain}`,
		};
	}
	const text = texts[0] as string;
	if (!isAscii(text)) {
		return {
			result: 'permerror',
			reason: `the SPF record at ${domain} holds a non-ASCII character`,
		};
	}
	const record = parseRecord(text);
	if (typeof record === 'string') {
		return {
			result: 'permerror',
			reason: `syntax error in the SPF record at ${domain}: ${record}`,
		};
	}
	return record;
}

/** `include` (§5.2): pass matches, fail, softfail and neutral do not, and anything else halts. */
async function included(run: Run, domain: string): Promise<boolean> {
	const outcome = await checkHost(run, domain);
	switch (outcome.result) {
		case 'pass':
			return true;
		case 'fail':
		case 'softfail':
		case 'neutral':
			return false;
		case 'none':
			throw new Halt('permerror', `include:${domain} has no SPF record`);
		default:
			throw new Halt(outcome.result, outcome.reason);
	}
}

/** `redirect=` (§6.1): the target's outcome is this domain's, and a target with no record is `permerror`. */
async function redirected(
	run: Run,
	spec: MacroString,
	domain: string,
): Promise<Outcome> {
	countLookup(run);
	const target = await targetName(run, spec, domain);
	const outcome = await checkHost(run, target);
	if (outcome.result !== 'none') return outcome;
	return {
		result: 'permerror',
		reason: `redirect=${target} has no SPF record`,
	};
}

/**
 * RFC 7208 §4's check_host() for `domain`: its record fetched, every
 * mechanism tried in order, then `redirect=`, else `neutral`. A limit
 * passed or a DNS failure inside throws a `Halt`, caught by `checkSpf`.
 */
export async function checkHost(run: Run, domain: string): Promise<Outcome> {
	const record = await recordOf(run, domain);
	if (!('mechanisms' in record)) return record;
	for (const mechanism of record.mechanisms) {
		if (!(await matches(run, mechanism, domain, (d) => included(run, d)))) {
			continue;
		}
		const result = WORDS[mechanism.qualifier];
		return {
			result,
			reason: `matched ${mechanism.text}`,
			mechanism: mechanism.text,
			...(result === 'fail' && record.exp !== undefined
				? { exp: { spec: record.exp, domain } }
				: {}),
		};
	}
	if (record.redirect !== undefined) {
		return redirected(run, record.redirect, domain);
	}
	return {
		result: 'neutral',
		reason: 'no mechanism matched (default neutral)',
	};
}
