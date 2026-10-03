import { lowerAscii } from '../text';
import { type Ip, parseIp4, parseIp6 } from './ip';
import { endsAsDomain, type MacroString, parseMacroString } from './macro';

/**
 * An SPF record (RFC 7208 §4.6): its terms parsed and checked whole before
 * any is evaluated, so a syntax error anywhere is a `permerror` (§4.6).
 * Terms are split on spaces only; any other control character is an error.
 */

export type Qualifier = '+' | '-' | '~' | '?';

interface Base {
	readonly qualifier: Qualifier;
	/** The term as written, for the result's `mechanism`. */
	readonly text: string;
}

export type Mechanism = Base &
	(
		| { readonly kind: 'all' }
		| { readonly kind: 'include' | 'exists'; readonly target: MacroString }
		| { readonly kind: 'ptr'; readonly target?: MacroString }
		| {
				readonly kind: 'a' | 'mx';
				readonly target?: MacroString;
				readonly cidr4: number;
				readonly cidr6: number;
		  }
		| {
				readonly kind: 'ip4' | 'ip6';
				readonly network: Ip;
				readonly prefix: number;
		  }
	);

export interface SpfRecord {
	readonly mechanisms: readonly Mechanism[];
	readonly redirect?: MacroString;
	readonly exp?: MacroString;
}

/** Whether a TXT record is an SPF record (§4.5): `v=spf1`, any case, then a space or the end. */
export function isSpfRecord(text: string): boolean {
	return (
		lowerAscii(text.slice(0, 6)) === 'v=spf1' &&
		(text.length === 6 || text.charCodeAt(6) === 0x20)
	);
}

/** A CIDR length: digits with no leading zero, at most `max`. */
function cidrOf(digits: string, max: number): number | undefined {
	if (!/^(?:0|[1-9][0-9]{0,2})$/.test(digits)) return undefined;
	const value = Number(digits);
	return value <= max ? value : undefined;
}

/** The CIDR suffixes to look for, last first, and their slot: `//n` is IPv6's, `/n` IPv4's. */
const DUAL = [
	['//', 1],
	['/', 0],
] as const;
const SINGLE = [['/', 0]] as const;

/** `rest` split into its domain-spec and its `/n` and `//n` (§5.3's `dual-cidr-length`), read from the end. */
function splitCidr(
	rest: string,
	dual: boolean,
): { spec: string; cidrs: (string | undefined)[] } {
	const cidrs: (string | undefined)[] = [undefined, undefined];
	let spec = rest;
	for (const [slashes, slot] of dual ? DUAL : SINGLE) {
		let start = spec.length;
		while (start > 0 && /[0-9]/.test(spec.charAt(start - 1))) start--;
		if (start === spec.length || !spec.endsWith(slashes, start)) continue;
		const at = start - slashes.length;
		if (slashes === '/' && spec.charAt(at - 1) === '/') continue;
		cidrs[slot] = spec.slice(start);
		spec = spec.slice(0, at);
	}
	return { spec, cidrs };
}

function domainSpec(text: string): MacroString | string {
	if (text === '') return 'an empty domain-spec';
	const parsed = parseMacroString(text, 'domain');
	if (typeof parsed === 'string') return parsed;
	if (!endsAsDomain(text, parsed)) {
		return `${JSON.stringify(text)} is not a domain-spec`;
	}
	return parsed.parts;
}

type Parsed<T> = T | string;

/** `a` and `mx`: an optional `:domain-spec`, then an optional dual CIDR. */
function addressMechanism(
	base: Base,
	kind: 'a' | 'mx',
	rest: string,
): Parsed<Mechanism> {
	const { spec, cidrs } = splitCidr(rest, true);
	const cidr4 = cidrs[0] === undefined ? 32 : cidrOf(cidrs[0], 32);
	const cidr6 = cidrs[1] === undefined ? 128 : cidrOf(cidrs[1], 128);
	if (cidr4 === undefined || cidr6 === undefined) {
		return `bad CIDR length in ${base.text}`;
	}
	if (spec === '') return { ...base, kind, cidr4, cidr6 };
	if (!spec.startsWith(':')) return `unknown mechanism ${base.text}`;
	const target = domainSpec(spec.slice(1));
	if (typeof target === 'string') return target;
	return { ...base, kind, target, cidr4, cidr6 };
}

function ipMechanism(
	base: Base,
	kind: 'ip4' | 'ip6',
	rest: string,
): Parsed<Mechanism> {
	if (!rest.startsWith(':')) return `${kind} has no network in ${base.text}`;
	const { spec, cidrs } = splitCidr(rest.slice(1), false);
	const max = kind === 'ip4' ? 32 : 128;
	const prefix = cidrs[0] === undefined ? max : cidrOf(cidrs[0], max);
	if (prefix === undefined) return `bad CIDR length in ${base.text}`;
	const network = kind === 'ip4' ? parseIp4(spec) : parseIp6(spec);
	if (network === undefined) return `bad ${kind} network in ${base.text}`;
	return { ...base, kind, network, prefix };
}

function targetMechanism(
	base: Base,
	kind: 'include' | 'exists' | 'ptr',
	rest: string,
): Parsed<Mechanism> {
	if (kind === 'ptr' && rest === '') return { ...base, kind };
	if (!rest.startsWith(':')) return `unknown mechanism ${base.text}`;
	const target = domainSpec(rest.slice(1));
	if (typeof target === 'string') return target;
	return { ...base, kind, target };
}

const QUALIFIERS = '+-~?';

/** One mechanism term (§5), or why it is not one. */
export function parseMechanism(text: string): Parsed<Mechanism> {
	const qualified = QUALIFIERS.includes(text.charAt(0));
	const qualifier = (qualified ? text.charAt(0) : '+') as Qualifier;
	const body = qualified ? text.slice(1) : text;
	let end = 0;
	while (end < body.length && /[a-z0-9]/i.test(body.charAt(end))) end++;
	const name = lowerAscii(body.slice(0, end));
	const rest = body.slice(end);
	const base: Base = { qualifier, text };
	switch (name) {
		case 'all':
			return rest === '' ? { ...base, kind: 'all' } : `malformed ${text}`;
		case 'a':
		case 'mx':
			return addressMechanism(base, name, rest);
		case 'ip4':
		case 'ip6':
			return ipMechanism(base, name, rest);
		case 'include':
		case 'exists':
		case 'ptr':
			return targetMechanism(base, name, rest);
		default:
			return `unknown mechanism ${text}`;
	}
}

/** A modifier's name (§6), when the term is one: a letter, then letters, digits, `-`, `_` or `.`, then `=`. */
function modifierName(term: string): string | undefined {
	const equals = term.indexOf('=');
	if (equals < 1) return undefined;
	const name = term.slice(0, equals);
	return /^[a-z][a-z0-9._-]*$/i.test(name) ? lowerAscii(name) : undefined;
}

interface Builder {
	mechanisms: Mechanism[];
	redirect?: MacroString;
	exp?: MacroString;
}

function addModifier(
	record: Builder,
	name: string,
	value: string,
): string | undefined {
	if (name !== 'redirect' && name !== 'exp') {
		const parsed = parseMacroString(value, 'value');
		return typeof parsed === 'string' ? parsed : undefined;
	}
	if (record[name] !== undefined) return `${name}= appears twice`;
	const target = domainSpec(value);
	if (typeof target === 'string') return `${name}=: ${target}`;
	record[name] = target;
	return undefined;
}

/** The record's terms, or the first syntax error in them. */
export function parseRecord(text: string): SpfRecord | string {
	const record: Builder = { mechanisms: [] };
	for (const term of text.slice(6).split(' ')) {
		if (term === '') continue;
		const name = modifierName(term);
		if (name !== undefined) {
			const error = addModifier(record, name, term.slice(name.length + 1));
			if (error !== undefined) return error;
			continue;
		}
		const mechanism = parseMechanism(term);
		if (typeof mechanism === 'string') return mechanism;
		record.mechanisms.push(mechanism);
	}
	return record;
}
