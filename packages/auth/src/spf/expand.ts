import { ipDots, ipText } from './ip';
import type { Macro, MacroString } from './macro';
import { validatedName } from './ptr';
import type { Run } from './run';

/** The longest name looked up: longer ones lose labels on the left (§7.3). */
const MAX_NAME = 253;

/** A letter's value, before any transformer (§7.2). */
async function letterValue(
	run: Run,
	letter: string,
	domain: string,
): Promise<string> {
	switch (letter) {
		case 's':
			return run.sender;
		case 'l':
			return run.local;
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
			return run.helo;
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
const encoder = new TextEncoder();

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

/** Split values, by letter, reversal and delimiters, so a macro repeated costs its split once. */
type Splits = Map<string, readonly string[]>;

async function partsOf(
	run: Run,
	macro: Macro,
	domain: string,
	splits: Splits,
): Promise<readonly string[]> {
	const delimiters = [...new Set(macro.delimiters)].sort().join('');
	const key = `${macro.letter}${macro.reverse ? 'r' : ''}${delimiters}`;
	const known = splits.get(key);
	if (known !== undefined) return known;
	const parts = split(await letterValue(run, macro.letter, domain), delimiters);
	if (macro.reverse) parts.reverse();
	splits.set(key, parts);
	return parts;
}

async function expandMacro(
	run: Run,
	macro: Macro,
	domain: string,
	splits: Splits,
): Promise<string> {
	const parts = await partsOf(run, macro, domain, splits);
	const kept =
		macro.keep !== undefined && macro.keep < parts.length
			? parts.slice(parts.length - macro.keep)
			: parts;
	const joined = kept.join('.');
	return macro.escape ? escapeUrl(joined) : joined;
}

/**
 * A macro-string expanded for `domain`, the domain whose record holds it,
 * or `undefined` past `MAX_EXPANSION` characters.
 */
export async function expand(
	run: Run,
	parts: MacroString,
	domain: string,
): Promise<string | undefined> {
	const splits: Splits = new Map();
	let out = '';
	for (const part of parts) {
		out +=
			typeof part === 'string'
				? part
				: await expandMacro(run, part, domain, splits);
		if (out.length > MAX_EXPANSION) return undefined;
	}
	return out;
}

/**
 * A domain-spec expanded into the name to look up: its final dot dropped,
 * and labels removed from the left until it fits in 253 characters (§7.3).
 * A macro bomb gives the empty name, which no lookup finds.
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
