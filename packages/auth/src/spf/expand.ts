import { ipDots, ipText } from './ip';
import type { Macro, MacroString } from './macro';
import { validatedName } from './ptr';
import type { Run } from './run';

/** The longest name looked up: longer ones lose labels on the left (§7.3). */
const MAX_NAME = 253;

/** RFC 5321 §4.5.3.1's limits: a local part of 64 octets, a HELO name (a domain) of 255. */
export const MAX_LOCAL = 64;
export const MAX_HELO = 255;

const encoder = new TextEncoder();

/** `text`, or `undefined` when it is longer than `max` octets. */
function capped(text: string, max: number): string | undefined {
	return encoder.encode(text).length <= max ? text : undefined;
}

/**
 * A letter's value, before any transformer (§7.2), or `undefined` for a
 * local part or a HELO name past RFC 5321's limits: no SMTP client may
 * send one, and the expansion that holds it is a name no lookup finds.
 */
async function letterValue(
	run: Run,
	letter: string,
	domain: string,
): Promise<string | undefined> {
	switch (letter) {
		case 's':
			return capped(run.local, MAX_LOCAL) === undefined
				? undefined
				: run.sender;
		case 'l':
			return capped(run.local, MAX_LOCAL);
		case 'o':
			return run.senderDomain;
		case 'd':
			return domain;
		case 'i':
			return ipDots(run.ip);
		case 'p':
			return validatedName(run, domain);
		case 'v':
			return run.ip.length === 4 ? 'in-addr' : 'ip6';
		case 'h':
			return capped(run.helo, MAX_HELO);
		case 'c':
			return ipText(run.ip);
		case 'r':
			return run.receiver;
		default:
			return String(run.now);
	}
}

/** `value` split on any of `delimiters`, in one scan. */
function split(value: string, delimiters: string): string[] {
	const parts: string[] = [];
	let start = 0;
	for (let i = 0; i < value.length; i++) {
		if (delimiters.includes(value.charAt(i))) {
			parts.push(value.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(value.slice(start));
	return parts;
}

const UNRESERVED = /[A-Za-z0-9._~-]/;

/** URL escaping as §7.3 asks of an uppercase letter: every byte outside RFC 3986's unreserved set as `%XX`. */
function escapeUrl(text: string): string {
	let out = '';
	for (const char of text) {
		if (UNRESERVED.test(char)) {
			out += char;
			continue;
		}
		for (const byte of encoder.encode(char)) {
			out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
		}
	}
	return out;
}

/**
 * The most an expansion may hold. A name is 253 characters and an
 * explanation a line of text; past this the record is a macro bomb, and
 * the expansion stops (§4.6.4 asks that a record not make the receiver
 * work without bound).
 */
export const MAX_EXPANSION = 8192;

/**
 * A macro's value split, once per check: kept on the run by letter,
 * reversal and delimiters, and by domain for `d` and `p`, the two that
 * change with each `include` and `redirect`.
 */
async function partsOf(
	run: Run,
	macro: Macro,
	domain: string,
): Promise<readonly string[] | undefined> {
	const delimiters = [...new Set(macro.delimiters)].sort().join('');
	const scope = macro.letter === 'd' || macro.letter === 'p' ? domain : '';
	const key = `${macro.letter}${macro.reverse ? 'r' : ''}${delimiters} ${scope}`;
	run.splits ??= new Map();
	if (run.splits.has(key)) return run.splits.get(key);
	const value = await letterValue(run, macro.letter, domain);
	const parts = value === undefined ? undefined : split(value, delimiters);
	if (macro.reverse) parts?.reverse();
	run.splits.set(key, parts);
	return parts;
}

async function expandMacro(
	run: Run,
	macro: Macro,
	domain: string,
): Promise<string | undefined> {
	const parts = await partsOf(run, macro, domain);
	if (parts === undefined) return undefined;
	const kept =
		macro.keep !== undefined && macro.keep < parts.length
			? parts.slice(parts.length - macro.keep)
			: parts;
	const joined = kept.join('.');
	return macro.escape ? escapeUrl(joined) : joined;
}

/**
 * A macro-string expanded for `domain`, the domain whose record holds it,
 * or `undefined` past `MAX_EXPANSION` characters, or when it holds a
 * local part or a HELO name past RFC 5321's limits.
 */
export async function expand(
	run: Run,
	parts: MacroString,
	domain: string,
): Promise<string | undefined> {
	let out = '';
	for (const part of parts) {
		const text =
			typeof part === 'string' ? part : await expandMacro(run, part, domain);
		if (text === undefined) return undefined;
		out += text;
		if (out.length > MAX_EXPANSION) return undefined;
	}
	return out;
}

/**
 * A domain-spec expanded into the name to look up: its final dot dropped,
 * and labels removed from the left until it fits in 253 characters (§7.3).
 * A macro bomb, or an over-long local part or HELO name, gives the empty
 * name, which no lookup finds.
 */
export async function targetName(
	run: Run,
	parts: MacroString,
	domain: string,
): Promise<string> {
	const expanded = (await expand(run, parts, domain)) ?? '';
	const name = expanded.endsWith('.') ? expanded.slice(0, -1) : expanded;
	if (name.length <= MAX_NAME) return name;
	const from = name.length - MAX_NAME;
	if (name.charAt(from - 1) === '.') return name.slice(from);
	const dot = name.indexOf('.', from);
	return dot < 0 ? name : name.slice(dot + 1);
}
