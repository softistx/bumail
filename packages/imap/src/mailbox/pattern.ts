import { canonical, DELIMITER } from './tree';

/** The longest LIST pattern taken. */
export const MAX_PATTERN = 1024;

/** The most patterns one LIST takes (RFC 5258 §3 allows a list of them). */
export const MAX_PATTERNS = 16;

/** Runs of wildcards as one: any run holding `*` is `*`, a run of `%` is `%`. */
function merged(pattern: string): string {
	return pattern.replace(/[*%]{2,}/g, (run) => (run.includes('*') ? '*' : '%'));
}

/**
 * A LIST pattern (RFC 9051 §6.3.9): `*` matches anything, `%` anything
 * but the delimiter. Matched by one greedy scan with two pointers: on a
 * mismatch, the last `%` takes one more character if it is not the
 * delimiter, else the last `*` does. Nothing is allocated per character,
 * and there is no backtracking past the last `*`: what came before it can
 * only have matched as early as possible.
 */
export function matcher(pattern: string): (name: string) => boolean {
	const glob = merged(canonical(pattern));
	return (name) => matches(glob, canonical(name));
}

function matches(glob: string, text: string): boolean {
	let p = 0;
	let t = 0;
	// Where to resume after the last `*`, and what it has taken up to.
	let star = -1;
	let starText = 0;
	// The same for the last `%` since that `*`.
	let percent = -1;
	let percentText = 0;
	while (t < text.length) {
		const char = glob[p];
		if (char === '*') {
			star = ++p;
			starText = t;
			percent = -1;
		} else if (char === '%') {
			percent = ++p;
			percentText = t;
		} else if (char === text[t]) {
			p++;
			t++;
		} else if (percent >= 0 && text[percentText] !== DELIMITER) {
			p = percent;
			t = ++percentText;
		} else if (star >= 0) {
			p = star;
			t = ++starText;
			percent = -1;
		} else return false;
	}
	while (glob[p] === '*' || glob[p] === '%') p++;
	return p === glob.length;
}
