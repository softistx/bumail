/** A key compared loosely: case, `_` and `-` aside, so `max_message_size` finds `maxMessageSize`. */
export function loose(key: string): string {
	return key.toLowerCase().replace(/[-_]/g, '');
}

/** Levenshtein's distance, for the short keys of a configuration. */
function distance(a: string, b: string): number {
	let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(
				(previous[j] ?? 0) + 1,
				(current[j - 1] ?? 0) + 1,
				(previous[j - 1] ?? 0) + cost,
			);
		}
		previous = current;
	}
	return previous[b.length] ?? 0;
}

/**
 * The known key `key` was most likely meant to be, if one is close: the
 * same but for case, `_` or `-`, or a typo or two away (one in a key of
 * up to five characters).
 */
export function didYouMean(
	key: string,
	known: readonly string[],
): string | undefined {
	const wanted = loose(key);
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (const candidate of known) {
		const d = distance(wanted, loose(candidate));
		if (d < bestDistance) {
			best = candidate;
			bestDistance = d;
		}
	}
	const allowed = wanted.length <= 5 ? 1 : 2;
	return bestDistance <= allowed ? best : undefined;
}
