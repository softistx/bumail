/** `*`: the last message of the mailbox, or its highest UID. */
export const LAST = '*';

export type SeqNumber = number | typeof LAST;

/** One element of a sequence set: a number, or a range in either order. */
export interface SeqRange {
	readonly from: SeqNumber;
	readonly to: SeqNumber;
}

export type SequenceSet = readonly SeqRange[];

const MAX_NUMBER = 0xffffffff;

/**
 * A sequence set (RFC 9051 §9, `sequence-set`): `1`, `2:4`, `5:*`, `1,3:5`.
 * Read in one pass, character by character; `undefined` for what is not
 * one. `$` (SEARCHRES) is not supported.
 */
export function parseSequenceSet(text: string): SequenceSet | undefined {
	const ranges: SeqRange[] = [];
	let at = 0;
	const number = (): SeqNumber | undefined => {
		if (text[at] === '*') {
			at++;
			return LAST;
		}
		const start = at;
		while (at < text.length && at - start <= 10) {
			const code = text.charCodeAt(at);
			if (code < 0x30 || code > 0x39) break;
			at++;
		}
		if (at === start || at - start > 10) return undefined;
		const value = Number(text.slice(start, at));
		return value >= 1 && value <= MAX_NUMBER ? value : undefined;
	};
	for (;;) {
		const from = number();
		if (from === undefined) return undefined;
		let to = from;
		if (text[at] === ':') {
			at++;
			const end = number();
			if (end === undefined) return undefined;
			to = end;
		}
		ranges.push({ from, to });
		if (at === text.length) return ranges;
		if (text[at] !== ',') return undefined;
		at++;
	}
}

/** Closed intervals, sorted and merged: what a set covers, once each. */
function merged(intervals: [number, number][]): [number, number][] {
	intervals.sort((a, b) => a[0] - b[0]);
	const out: [number, number][] = [];
	for (const [from, to] of intervals) {
		const last = out[out.length - 1];
		if (last && from <= last[1] + 1) last[1] = Math.max(last[1], to);
		else out.push([from, to]);
	}
	return out;
}

function interval(range: SeqRange, last: number): [number, number] {
	const from = range.from === LAST ? last : range.from;
	const to = range.to === LAST ? last : range.to;
	return from <= to ? [from, to] : [to, from];
}

/**
 * The 0-based positions a set of message sequence numbers names, among
 * `count` messages; `undefined` when it names a number past the last
 * (RFC 9051 §6.4.4 asks for BAD) — unless `lenient`, as SEARCH is. Ranges are never expanded: the work is
 * the number of ranges and of messages named, never the numbers spanned.
 */
export function seqPositions(
	set: SequenceSet,
	count: number,
	lenient = false,
): number[] | undefined {
	const intervals: [number, number][] = [];
	for (const range of set) {
		const [from, to] = interval(range, count);
		if (lenient) {
			// SEARCH: numbers past the last message name nothing.
			if (from <= count) intervals.push([from, Math.min(to, count)]);
			continue;
		}
		if (count === 0 || to > count || from < 1) return undefined;
		intervals.push([from, to]);
	}
	const positions: number[] = [];
	for (const [from, to] of merged(intervals)) {
		for (let n = from; n <= to; n++) positions.push(n - 1);
	}
	return positions;
}

/** The first index of `uids` (ascending) holding a UID at least `uid`. */
export function lowerBound(uids: readonly number[], uid: number): number {
	let low = 0;
	let high = uids.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if ((uids[mid] as number) < uid) low = mid + 1;
		else high = mid;
	}
	return low;
}

/**
 * The 0-based positions of the UIDs a set names, among `uids` (ascending).
 * A UID that names no message is skipped; `*` is the highest UID, so
 * `n:*` names the last message even when `n` is past it (§6.4.8).
 */
export function uidPositions(
	set: SequenceSet,
	uids: readonly number[],
): number[] {
	if (uids.length === 0) return [];
	const last = uids[uids.length - 1] as number;
	const positions: number[] = [];
	for (const [from, to] of merged(set.map((range) => interval(range, last)))) {
		const end = lowerBound(uids, to + 1);
		for (let i = lowerBound(uids, from); i < end; i++) positions.push(i);
	}
	return positions;
}

/** Ascending numbers as a compact sequence set: `1:3,5,7:9`. */
export function formatSequenceSet(numbers: readonly number[]): string {
	const parts: string[] = [];
	let i = 0;
	while (i < numbers.length) {
		const start = numbers[i] as number;
		let end = start;
		while (numbers[i + 1] === end + 1) {
			end++;
			i++;
		}
		parts.push(start === end ? `${start}` : `${start}:${end}`);
		i++;
	}
	return parts.join(',');
}
