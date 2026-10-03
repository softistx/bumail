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

const pad = (n: number) => String(n).padStart(2, '0');

/** INTERNALDATE as RFC 9051 §9 writes it, in UTC: `"02-Oct-2026 22:00:00 +0000"`. */
export function formatDateTime(date: Date): string {
	const month = (MONTHS[date.getUTCMonth()] as string).replace(/^./, (c) =>
		c.toUpperCase(),
	);
	return (
		`"${pad(date.getUTCDate())}-${month}-${date.getUTCFullYear()} ` +
		`${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
		`${pad(date.getUTCSeconds())} +0000"`
	);
}

function day(year: number, month: number, date: number): number | undefined {
	const utc = Date.UTC(year, month, date);
	return new Date(utc).getUTCDate() === date ? utc : undefined;
}

/**
 * A SEARCH date (`date-text`, RFC 9051 §9): `1-Feb-1994`, as the UTC
 * midnight that starts it. `undefined` for what is not a date.
 */
export function parseDate(text: string): number | undefined {
	const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(text);
	if (!match) return undefined;
	const month = MONTHS.indexOf((match[2] as string).toLowerCase());
	if (month < 0) return undefined;
	return day(Number(match[3]), month, Number(match[1]));
}

/**
 * APPEND's `date-time`: `" 2-Feb-1994 21:52:25 -0800"` without its quotes.
 * `undefined` for what is not one.
 */
export function parseDateTime(text: string): Date | undefined {
	const match =
		/^([ \d]\d)-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/.exec(
			text,
		);
	if (!match) return undefined;
	const [, d, mon, y, h, m, s, sign, zh, zm] = match as unknown as string[];
	const month = MONTHS.indexOf((mon as string).toLowerCase());
	const midnight = day(Number(y), month, Number((d as string).trim()));
	if (month < 0 || midnight === undefined) return undefined;
	if (Number(h) > 23 || Number(m) > 59 || Number(s) > 60) return undefined;
	const offset =
		(sign === '-' ? -1 : 1) * (Number(zh) * 60 + Number(zm)) * 60_000;
	const time =
		midnight +
		((Number(h) * 60 + Number(m)) * 60 + Math.min(Number(s), 59)) * 1000;
	return new Date(time - offset);
}

/** The UTC midnight that starts the day of `date`, for BEFORE, ON and SINCE. */
export function dayOf(date: Date): number {
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
