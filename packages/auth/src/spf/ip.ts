/**
 * IP addresses as SPF reads them: 4 bytes for IPv4, 16 for IPv6, parsed
 * by index scans and matched against a CIDR prefix bit by bit. Nothing
 * here throws: a text that is not an address gives `undefined`.
 */

/** An address: 4 bytes (IPv4) or 16 (IPv6). */
export type Ip = Uint8Array;

function isDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

function hexValue(code: number): number {
	if (isDigit(code)) return code - 0x30;
	const lower = code | 0x20;
	return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : -1;
}

/**
 * A dotted quad as RFC 7208 §5.6 writes `ip4-network`: four numbers of
 * 0 to 255, none with a leading zero.
 */
export function parseIp4(text: string): Ip | undefined {
	const parts = text.split('.');
	if (parts.length !== 4) return undefined;
	const bytes = new Uint8Array(4);
	for (let i = 0; i < 4; i++) {
		const part = parts[i] as string;
		if (part.length === 0 || part.length > 3) return undefined;
		if (part.length > 1 && part.charCodeAt(0) === 0x30) return undefined;
		let value = 0;
		for (let j = 0; j < part.length; j++) {
			const code = part.charCodeAt(j);
			if (!isDigit(code)) return undefined;
			value = value * 10 + code - 0x30;
		}
		if (value > 255) return undefined;
		bytes[i] = value;
	}
	return bytes;
}

/** Hex groups of one side of `::`, an IPv4 tail allowed on the last side. */
function groupsOf(text: string, last: boolean): number[] | undefined {
	if (text === '') return [];
	const parts = text.split(':');
	const groups: number[] = [];
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i] as string;
		if (last && i === parts.length - 1 && part.includes('.')) {
			const v4 = parseIp4(part);
			if (v4 === undefined) return undefined;
			groups.push(((v4[0] as number) << 8) | (v4[1] as number));
			groups.push(((v4[2] as number) << 8) | (v4[3] as number));
			continue;
		}
		if (part.length === 0 || part.length > 4) return undefined;
		let value = 0;
		for (let j = 0; j < part.length; j++) {
			const digit = hexValue(part.charCodeAt(j));
			if (digit < 0) return undefined;
			value = (value << 4) | digit;
		}
		groups.push(value);
	}
	return groups;
}

/** An IPv6 address as RFC 4291 §2.2 writes it, `::` and an IPv4 tail included; no zone. */
export function parseIp6(text: string): Ip | undefined {
	if (text.length > 45) return undefined;
	const gap = text.indexOf('::');
	if (gap >= 0 && text.indexOf('::', gap + 1) >= 0) return undefined;
	const head = groupsOf(gap < 0 ? text : text.slice(0, gap), gap < 0);
	const tail = gap < 0 ? [] : groupsOf(text.slice(gap + 2), true);
	if (head === undefined || tail === undefined) return undefined;
	const missing = 8 - head.length - tail.length;
	if (gap < 0 ? missing !== 0 : missing < 1) return undefined;
	const groups = [...head, ...new Array<number>(missing).fill(0), ...tail];
	if (gap < 0 && groups.length !== 8) return undefined;
	const bytes = new Uint8Array(16);
	groups.forEach((group, i) => {
		bytes[2 * i] = group >> 8;
		bytes[2 * i + 1] = group & 0xff;
	});
	return bytes;
}

/**
 * The client address: IPv4, or IPv6 with an IPv4-mapped address
 * (`::ffff:192.0.2.1`) folded to IPv4, as RFC 7208 §5 requires.
 */
export function parseClientIp(text: string): Ip | undefined {
	const v4 = parseIp4(text);
	if (v4 !== undefined) return v4;
	const v6 = parseIp6(text);
	if (v6 === undefined) return undefined;
	const mapped =
		v6.subarray(0, 10).every((byte) => byte === 0) &&
		v6[10] === 0xff &&
		v6[11] === 0xff;
	return mapped ? v6.slice(12) : v6;
}

/** An address from a resolver's A or AAAA answer. */
export function parseAnswer(text: string): Ip | undefined {
	return parseIp4(text) ?? parseIp6(text);
}

/** Whether `ip` is in `network/prefix`; addresses of two families never match. */
export function inNetwork(ip: Ip, network: Ip, prefix: number): boolean {
	if (ip.length !== network.length) return false;
	const whole = prefix >> 3;
	for (let i = 0; i < whole; i++) if (ip[i] !== network[i]) return false;
	const rest = prefix & 7;
	if (rest === 0) return true;
	const mask = (0xff << (8 - rest)) & 0xff;
	return ((ip[whole] as number) & mask) === ((network[whole] as number) & mask);
}

function hexGroups(ip: Ip): number[] {
	const groups: number[] = [];
	for (let i = 0; i < 16; i += 2) {
		groups.push(((ip[i] as number) << 8) | (ip[i + 1] as number));
	}
	return groups;
}

/** The longest run of two or more zero groups, as RFC 5952 §4.2 compresses it. */
function longestZeros(groups: readonly number[]): [number, number] {
	let best: [number, number] = [-1, 0];
	let start = -1;
	for (let i = 0; i <= groups.length; i++) {
		if (i < groups.length && groups[i] === 0) {
			if (start < 0) start = i;
			continue;
		}
		if (start >= 0 && i - start > best[1] && i - start > 1) {
			best = [start, i - start];
		}
		start = -1;
	}
	return best;
}

/** The address as `%{c}` writes it: a dotted quad, or IPv6 in RFC 5952's form. */
export function ipText(ip: Ip): string {
	if (ip.length === 4) return ip.join('.');
	const groups = hexGroups(ip).map((group) => group.toString(16));
	const [start, length] = longestZeros(hexGroups(ip));
	if (start < 0) return groups.join(':');
	const head = groups.slice(0, start).join(':');
	const tail = groups.slice(start + length).join(':');
	return `${head}::${tail}`;
}

/** The address as `%{i}` writes it: a dotted quad, or IPv6 as 32 dot-separated nibbles (§7.3). */
export function ipDots(ip: Ip): string {
	if (ip.length === 4) return ip.join('.');
	const nibbles: string[] = [];
	for (const byte of ip) {
		nibbles.push((byte >> 4).toString(16), (byte & 0xf).toString(16));
	}
	return nibbles.join('.');
}
