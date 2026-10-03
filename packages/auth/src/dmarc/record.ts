import { colonList } from '../dkim/tags';
import { lowerAscii, trimFws } from '../text';
import type { DmarcPolicy, DmarcRecord, DmarcUri } from './result';

/**
 * A DMARC record (RFC 7489 §6.3, §6.4), read leniently as §6.3 asks: an
 * unknown tag is ignored, a tag written wrong takes its default, and a
 * tag given twice keeps its first value. Only `v=DMARC1` first decides
 * whether the text is a DMARC record at all. Every step is a split or an
 * index scan, linear in the record's length.
 */

/** One `name=value` per `;`, names lowercased (ABNF strings ignore case), values trimmed. */
function tagsOf(text: string): Map<string, string> {
	const tags = new Map<string, string>();
	for (const spec of text.split(';')) {
		const equals = spec.indexOf('=');
		if (equals < 0) continue;
		const name = lowerAscii(trimFws(spec.slice(0, equals)));
		if (!tags.has(name)) tags.set(name, trimFws(spec.slice(equals + 1)));
	}
	return tags;
}

/** Whether the text starts with `v=DMARC1` (§6.6.3 steps 2 and 4); `DMARC1` is case-sensitive. */
export function isDmarcRecord(text: string): boolean {
	const semicolon = text.indexOf(';');
	const first = semicolon < 0 ? text : text.slice(0, semicolon);
	const equals = first.indexOf('=');
	if (equals < 0) return false;
	return (
		lowerAscii(trimFws(first.slice(0, equals))) === 'v' &&
		trimFws(first.slice(equals + 1)) === 'DMARC1'
	);
}

const POLICIES: readonly string[] = ['none', 'quarantine', 'reject'];

function policyOf(value: string | undefined): DmarcPolicy | undefined {
	if (value === undefined) return undefined;
	const lower = lowerAscii(value);
	return POLICIES.includes(lower) ? (lower as DmarcPolicy) : undefined;
}

function modeOf(value: string | undefined): 'r' | 's' {
	return value !== undefined && lowerAscii(value) === 's' ? 's' : 'r';
}

/** A whole number of at most `digits` digits and at most `max`, or `fallback`. */
function numberOf(
	value: string | undefined,
	digits: number,
	max: number,
	fallback: number,
): number {
	if (value === undefined || value.length === 0 || value.length > digits) {
		return fallback;
	}
	if (!/^[0-9]+$/.test(value)) return fallback;
	const n = Number(value);
	return n <= max ? n : fallback;
}

/** A colon list whose every item `valid` accepts, lowercased, or `fallback`. */
function listOf(
	value: string | undefined,
	valid: (item: string) => boolean,
	fallback: readonly string[],
): readonly string[] {
	if (value === undefined) return fallback;
	const items = colonList(value).map(lowerAscii);
	return items.every(valid) ? items : fallback;
}

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const NOT_URI = /[^\x21-\x7e]/;
const SIZE = /^([0-9]{1,20})([kmgt]?)$/i;
const UNITS: Readonly<Record<string, number>> = {
	'': 1,
	k: 2 ** 10,
	m: 2 ** 20,
	g: 2 ** 30,
	t: 2 ** 40,
};

/** `dmarc-uri` (§6.4): a URI, then `!` and a size with an optional unit; `undefined` when it does not parse. */
export function parseUri(text: string): DmarcUri | undefined {
	let uri = text;
	let maxSize: number | undefined;
	const bang = text.lastIndexOf('!');
	if (bang >= 0) {
		const size = SIZE.exec(text.slice(bang + 1));
		if (size === null) return undefined;
		const unit = UNITS[lowerAscii(size[2] ?? '')] ?? 1;
		maxSize = Number(size[1]) * unit;
		if (!Number.isSafeInteger(maxSize)) return undefined;
		uri = text.slice(0, bang);
	}
	const scheme = SCHEME.exec(uri);
	if (scheme === null || uri.length === scheme[0].length) return undefined;
	if (NOT_URI.test(uri)) return undefined;
	return maxSize === undefined ? { uri } : { uri, maxSize };
}

/** The URIs of `rua=` or `ruf=` that parse; the others are dropped. */
function urisOf(value: string | undefined): readonly DmarcUri[] {
	if (value === undefined) return [];
	const uris: DmarcUri[] = [];
	for (const item of value.split(',')) {
		const uri = parseUri(trimFws(item));
		if (uri !== undefined) uris.push(uri);
	}
	return uris;
}

const FO = ['0', '1', 'd', 's'];
const KEYWORD = /^[a-z0-9][a-z0-9-]*$/;

/** The record's tags, with their defaults; call it on text `isDmarcRecord` accepted. */
export function parseDmarcRecord(text: string): DmarcRecord {
	const tags = tagsOf(text);
	const p = policyOf(tags.get('p'));
	const sp = policyOf(tags.get('sp'));
	return {
		...(p === undefined ? {} : { p }),
		...(sp === undefined ? {} : { sp }),
		invalidSp: tags.has('sp') && sp === undefined,
		adkim: modeOf(tags.get('adkim')),
		aspf: modeOf(tags.get('aspf')),
		pct: numberOf(tags.get('pct'), 3, 100, 100),
		rua: urisOf(tags.get('rua')),
		ruf: urisOf(tags.get('ruf')),
		fo: listOf(tags.get('fo'), (item) => FO.includes(item), ['0']),
		rf: listOf(tags.get('rf'), (item) => KEYWORD.test(item), ['afrf']),
		ri: numberOf(tags.get('ri'), 10, 2 ** 32 - 1, 86_400),
	};
}
