import { isIP } from 'node:net';
import { DnsError } from './errors';
import { normalizeName } from './name';
import { pieces, quoted } from './zone-text';

/** The record types `formatZone` writes. */
export type ZoneRecordType =
	| 'A'
	| 'AAAA'
	| 'MX'
	| 'TXT'
	| 'SRV'
	| 'CAA'
	| 'CNAME'
	| 'NS'
	| 'PTR';

/**
 * One record to publish. `value` is what the type holds, written plainly:
 *
 * - `A`, `AAAA`: the address.
 * - `MX`, `CNAME`, `NS`, `PTR`: the host name, with or without a trailing
 *   dot; an MX's `value` of `.` is a null MX (RFC 7505).
 * - `TXT`: the text, unescaped and of any length.
 * - `SRV`: `<weight> <port> <target>`, such as `1 993 mail.example.com`.
 * - `CAA`: `<flags> <tag> <value>`, such as `0 issue letsencrypt.org`.
 */
export interface ZoneRecord {
	/** The owner name, always an absolute one: `example.com` is `example.com.`, never relative to an origin. */
	readonly name: string;
	readonly type: ZoneRecordType;
	/** Seconds; left out, the zone's default applies. */
	readonly ttl?: number;
	readonly value: string;
	/** The preference of an `MX`, or the priority of an `SRV`; required for those two and refused for the others. */
	readonly priority?: number;
}

const MAX_TTL = 2 ** 31 - 1;

function refuse(
	index: number,
	why: string,
	code: 'INVALID_NAME' | 'INVALID_OPTION',
): DnsError {
	return new DnsError(code, `formatZone(): records[${index}]: ${why}`);
}

/** A whole number from 0 to `max`, or why not. */
function integer(text: number | string, max: number): number | undefined {
	const n =
		typeof text === 'number'
			? text
			: /^[0-9]{1,10}$/.test(text)
				? Number(text)
				: Number.NaN;
	return Number.isInteger(n) && n >= 0 && n <= max ? n : undefined;
}

/** A host name as a zone holds a target: absolute, with its trailing dot. `.` stays itself where `allowRoot`. */
function target(text: string, allowRoot: boolean): string | undefined {
	if (text === '.') return allowRoot ? '.' : undefined;
	try {
		return `${normalizeName(text)}.`;
	} catch {
		return undefined;
	}
}

/** A CAA value as the zone holds it: `<flags> <tag> "<value>"`. */
function caa(value: string): string | undefined {
	const parts = /^([0-9]{1,3}) ([A-Za-z0-9]{1,15}) (.+)$/.exec(value);
	if (parts === null || Number(parts[1]) > 255) return undefined;
	const text = parts[3] ?? '';
	const inner =
		text.length >= 2 && text.startsWith('"') && text.endsWith('"')
			? text.slice(1, -1).replace(/\\(.)/g, '$1')
			: text;
	return `${parts[1]} ${parts[2]} ${quoted(inner)}`;
}

/** An SRV's `<weight> <port> <target>`, its target absolute. */
function srv(priority: number, value: string): string | undefined {
	const parts = /^([0-9]+) ([0-9]+) (\S+)$/.exec(value);
	const host = parts === null ? undefined : target(parts[3] ?? '', true);
	if (parts === null || host === undefined) return undefined;
	if (integer(parts[1] ?? '', 65_535) === undefined) return undefined;
	if (integer(parts[2] ?? '', 65_535) === undefined) return undefined;
	return `${priority} ${parts[1]} ${parts[2]} ${host}`;
}

const SHAPES: Readonly<Record<string, string>> = {
	A: 'an IPv4 address',
	AAAA: 'an IPv6 address',
	MX: 'a host name',
	CNAME: 'a host name',
	NS: 'a host name',
	PTR: 'a host name',
	SRV: '"<weight> <port> <target>", such as "1 993 mail.example.com"',
	CAA: '"<flags> <tag> <value>", such as "0 issue letsencrypt.org"',
};

/** The record's data, as the zone holds it, or why it is not valid. */
function rdata(record: ZoneRecord, index: number): string {
	const { type, value } = record;
	const bad = () =>
		refuse(
			index,
			`the ${type} value ${JSON.stringify(value)} is not ${SHAPES[type]}`,
			'INVALID_OPTION',
		);
	if (type === 'TXT') return pieces(value).map(quoted).join(' ');
	if (type === 'A' || type === 'AAAA') {
		if (isIP(value) !== (type === 'A' ? 4 : 6)) throw bad();
		return value;
	}
	if (type === 'SRV') {
		const text = srv(record.priority ?? 0, value);
		if (text === undefined) throw bad();
		return text;
	}
	if (type === 'CAA') {
		const text = caa(value);
		if (text === undefined) throw bad();
		return text;
	}
	const host = target(value, type === 'MX');
	if (host === undefined) throw bad();
	return type === 'MX' ? `${record.priority ?? 0} ${host}` : host;
}

function line(record: ZoneRecord, index: number): string {
	if (typeof record !== 'object' || record === null) {
		throw refuse(index, 'must be an object', 'INVALID_OPTION');
	}
	const { type, ttl, priority } = record;
	if (!Object.hasOwn(SHAPES, type) && type !== 'TXT') {
		throw refuse(
			index,
			`the type ${JSON.stringify(type)} is not one of A, AAAA, MX, TXT, SRV, CAA, CNAME, NS, PTR`,
			'INVALID_OPTION',
		);
	}
	if (typeof record.value !== 'string') {
		throw refuse(index, 'value must be a string', 'INVALID_OPTION');
	}
	if (ttl !== undefined && integer(ttl, MAX_TTL) === undefined) {
		throw refuse(
			index,
			`ttl must be an integer from 0 to ${MAX_TTL}, not ${String(ttl)}`,
			'INVALID_OPTION',
		);
	}
	const prioritised = type === 'MX' || type === 'SRV';
	if (prioritised !== (priority !== undefined)) {
		throw refuse(
			index,
			prioritised
				? `${type} records need a priority`
				: `${type} records take no priority`,
			'INVALID_OPTION',
		);
	}
	if (priority !== undefined && integer(priority, 65_535) === undefined) {
		throw refuse(
			index,
			`priority must be an integer from 0 to 65535, not ${String(priority)}`,
			'INVALID_OPTION',
		);
	}
	let owner: string;
	try {
		owner = `${normalizeName(record.name)}.`;
	} catch (error) {
		if (!(error instanceof DnsError)) throw error;
		throw refuse(index, `name: ${error.message}`, 'INVALID_NAME');
	}
	const columns = [
		owner,
		...(ttl === undefined ? [] : [String(ttl)]),
		'IN',
		type,
		rdata(record, index),
	];
	return columns.join(' ');
}

/**
 * Records as BIND zone-file lines, one each, ending in a newline: the
 * format Cloudflare, Route 53, and most DNS hosts import.
 *
 * ```ts
 * formatZone([
 *   { name: 'example.com', type: 'MX', priority: 10, value: 'mail.example.com' },
 *   { name: 'example.com', type: 'TXT', ttl: 3600, value: 'v=spf1 mx -all' },
 * ]);
 * // example.com. IN MX 10 mail.example.com.
 * // example.com. 3600 IN TXT "v=spf1 mx -all"
 * ```
 *
 * Every name is absolute and gets its trailing dot; one is lowercased and
 * an IDN written in its A-labels, as `normalizeName` does. A TXT value
 * is cut into quoted strings of 255 bytes at most (RFC 1035 §3.3), never
 * in the middle of a character, with `"` and `\` escaped and a control
 * character as `\DDD`; a resolver joins the strings back, so what
 * `txt()` answers is the value you gave. A name, an address or a value
 * the type cannot hold throws `DnsError`, `INVALID_NAME` for a name and
 * `INVALID_OPTION` for the rest, naming the record by its index.
 */
export function formatZone(records: readonly ZoneRecord[]): string {
	if (!Array.isArray(records)) {
		throw new DnsError(
			'INVALID_OPTION',
			'formatZone(): records must be an array',
		);
	}
	return records.map((record, index) => `${line(record, index)}\n`).join('');
}
