import { MimeError } from '../errors';

const MONTHS = [
	'jan',
	'feb',
	'mar',
	'apr',
	'may',
	'jun',
	'jul',
	'aug',
	'sep',
	'oct',
	'nov',
	'dec',
];

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** The obsolete zone names of RFC 5322 §4.3, in minutes east of UTC. */
const ZONES: Readonly<Record<string, number>> = {
	ut: 0,
	gmt: 0,
	z: 0,
	edt: -240,
	est: -300,
	cdt: -300,
	cst: -360,
	mdt: -360,
	mst: -420,
	pdt: -420,
	pst: -480,
};

/**
 * The value with each comment, nested ones included (RFC 5322 §3.2.2),
 * turned into a space, in one pass: a regex would rescan from every `(`
 * of an unclosed comment. An unclosed comment runs to the end.
 */
function withoutComments(value: string): string {
	let out = '';
	let depth = 0;
	let from = 0;
	for (let i = 0; i < value.length; i++) {
		const c = value[i];
		if (depth > 0 && c === '\\') i++;
		else if (c === '(') {
			if (depth++ === 0) out += value.slice(from, i);
		} else if (c === ')' && depth > 0 && --depth === 0) {
			out += ' ';
			from = i + 1;
		}
	}
	return depth > 0 ? out : out + value.slice(from);
}

/**
 * Parses an RFC 5322 date-time (§3.3), with §4.3's obsolete forms: two- and
 * three-digit years, named zones, and comments. A military zone letter
 * other than `Z` is read as UTC, as §4.3 asks, since senders got their sign
 * wrong. `undefined` for what is not a date.
 */
export function parseDate(value: string): Date | undefined {
	const text = withoutComments(value)
		.replace(/^\s*[A-Za-z]+\s*,/, ' ')
		.trim();
	const match =
		/^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]+)?/.exec(
			text,
		);
	if (!match) return undefined;
	const [, day, monthName, yearText, hour, minute, second, zone] = match;
	const month = MONTHS.indexOf((monthName as string).toLowerCase());
	if (month < 0) return undefined;
	let year = Number(yearText);
	if ((yearText as string).length === 2) year += year < 50 ? 2000 : 1900;
	else if ((yearText as string).length === 3) year += 1900;
	let offset = 0;
	if (zone && /^[+-]\d{4}$/.test(zone)) {
		const sign = zone[0] === '-' ? -1 : 1;
		offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
	} else if (zone) {
		offset = ZONES[zone.toLowerCase()] ?? 0;
	}
	const [d, h, m, sec] = [
		Number(day),
		Number(hour),
		Number(minute),
		Number(second ?? 0),
	];
	// §3.3: a leap second may read 60; it is kept as 59 rather than rolled over.
	if (h > 23 || m > 59 || sec > 60) return undefined;
	const utc = Date.UTC(year, month, d, h, m, Math.min(sec, 59));
	// A day the month does not have — 31 Feb — is not a date.
	if (new Date(utc).getUTCDate() !== d) return undefined;
	return new Date(utc - offset * 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A date as RFC 5322 §3.3 writes it, in UTC: `Fri, 02 Oct 2026 22:00:00 +0000`. */
export function formatDate(date: Date): string {
	if (Number.isNaN(date.getTime())) {
		throw new MimeError('INVALID_OPTION', 'formatDate(): the date is invalid');
	}
	const year = date.getUTCFullYear();
	// Four digits, and no earlier than RFC 5322 §4.3's obsolete two-digit years reach.
	if (year < 1900 || year > 9999) {
		throw new MimeError(
			'INVALID_OPTION',
			`formatDate(): the year ${year} is outside 1900–9999`,
		);
	}
	return (
		`${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ` +
		`${(MONTHS[date.getUTCMonth()] as string).replace(/^./, (c) => c.toUpperCase())} ` +
		`${date.getUTCFullYear()} ${pad(date.getUTCHours())}:` +
		`${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} +0000`
	);
}
