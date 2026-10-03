import { normalizeName } from '@bumail/dns';
import { PSL_RULES } from './psl-data';

/**
 * The organizational domain (RFC 7489 §3.2) from the Public Suffix List
 * embedded in `psl-data.ts`. Its rules are decoded on first use, once, and
 * a lookup walks at most as many labels as the longest rule has.
 */

/** One name of the trie: a rule, or only a step on the way to one. */
interface Node {
	rule: boolean;
	kids?: Map<string, Node>;
}

type Level = Map<string, Node>;

const COMMA = 0x2c;
const OPEN = 0x28;
const CLOSE = 0x29;
const MARK = 0x3f;

/**
 * Reads `label[?][(children)]`, comma-separated, rightmost label first,
 * with one index scan: `?` marks a name that is not a rule itself.
 */
export function decodeRules(text: string): Level {
	const root: Level = new Map();
	const stack: Level[] = [];
	let level = root;
	let last: Node | undefined;
	let start = 0;
	for (let i = 0; i <= text.length; i++) {
		const code = i < text.length ? text.charCodeAt(i) : COMMA;
		if (code !== COMMA && code !== OPEN && code !== CLOSE && code !== MARK) {
			continue;
		}
		if (i > start) {
			last = { rule: true };
			level.set(text.slice(start, i), last);
		}
		if (code === MARK && last !== undefined) last.rule = false;
		if (code === OPEN && last !== undefined) {
			last.kids = new Map();
			stack.push(level);
			level = last.kids;
		}
		if (code === CLOSE) level = stack.pop() ?? root;
		start = i + 1;
	}
	return root;
}

let decoded: Level | undefined;

function rules(): Level {
	decoded ??= decodeRules(PSL_RULES);
	return decoded;
}

/**
 * How many labels, from the right, the public suffix of `labels` (given
 * rightmost first) has: the longest rule that matches, an exception rule
 * before any other, and `*` (one label) when none does.
 */
function suffixLength(labels: readonly string[], root: Level): number {
	let longest = 1;
	let exception = 0;
	const walk = (level: Level, depth: number): void => {
		const label = labels[depth];
		if (label === undefined) return;
		if (level.get(`!${label}`)?.rule) exception = Math.max(exception, depth);
		for (const node of [level.get(label), level.get('*')]) {
			if (node === undefined) continue;
			if (node.rule) longest = Math.max(longest, depth + 1);
			if (node.kids !== undefined) walk(node.kids, depth + 1);
		}
	};
	walk(root, 0);
	return exception > 0 ? exception : longest;
}

/**
 * The organizational domain of `domain` (RFC 7489 §3.2): its public
 * suffix and one label more, in A-labels, lowercase. `undefined` when the
 * domain is itself a public suffix (`com`, `co.uk`), which no domain can
 * align with, or is not a name to look up.
 *
 * The suffixes are the Public Suffix List's, ICANN and private sections
 * both, as of the snapshot this version of the package embeds.
 */
export function organizationalDomain(domain: string): string | undefined {
	let name: string;
	try {
		name = normalizeName(domain);
	} catch {
		return undefined;
	}
	const labels = name.split('.').reverse();
	const suffix = suffixLength(labels, rules());
	if (labels.length <= suffix) return undefined;
	return labels
		.slice(0, suffix + 1)
		.reverse()
		.join('.');
}
