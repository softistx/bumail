import { canonical, DELIMITER } from './tree';

/** The longest LIST pattern taken. */
export const MAX_PATTERN = 1024;

/**
 * A LIST pattern (RFC 9051 §6.3.9): `*` matches anything, `%` anything
 * but the delimiter. Matched by dynamic programming over pattern and name,
 * one row at a time: time is the product of their lengths, both bounded,
 * whatever the wildcards — never the backtracking of a regular expression.
 */
export function matcher(pattern: string): (name: string) => boolean {
	const glob = canonical(pattern);
	return (name) => {
		const text = canonical(name);
		// row[j]: the pattern's first i characters match the text's first j.
		let row = new Array<boolean>(text.length + 1).fill(false);
		row[0] = true;
		for (let i = 0; i < glob.length; i++) {
			const char = glob[i];
			const next = new Array<boolean>(text.length + 1).fill(false);
			if (char === '*' || char === '%') {
				next[0] = row[0] as boolean;
				for (let j = 1; j <= text.length; j++) {
					const wild = char === '*' || text[j - 1] !== DELIMITER;
					next[j] = (row[j] as boolean) || (wild && (next[j - 1] as boolean));
				}
			} else {
				for (let j = 1; j <= text.length; j++) {
					next[j] = (row[j - 1] as boolean) && text[j - 1] === char;
				}
			}
			row = next;
		}
		return row[text.length] as boolean;
	};
}
