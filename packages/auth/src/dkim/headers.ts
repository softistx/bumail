import { lowerAscii, trimWspEnd } from '../text';

/** One header field as written, for hashing. */
export interface RawField {
	/** The name, lowercased (ASCII) and without white space before the colon: what `h=` is matched against. */
	readonly name: string;
	/** The whole field — name, colon, value and folding — its line breaks as CRLF, without the final one. */
	readonly raw: string;
}

/**
 * The fields of a header block given as a binary string. A line that
 * starts with white space continues the field before it; a line with no
 * colon, or a continuation with no field before it, is not a field and
 * is skipped: nothing can select it.
 */
export function splitFields(header: string): RawField[] {
	const fields: RawField[] = [];
	let lines: string[] = [];
	const flush = () => {
		const first = lines[0];
		if (first !== undefined) {
			const colon = first.indexOf(':');
			if (colon > 0) {
				const name = lowerAscii(trimWspEnd(first.slice(0, colon)));
				fields.push({ name, raw: lines.join('\r\n') });
			}
		}
		lines = [];
	};
	for (const line of header.split(/\r?\n/)) {
		if (line === '') continue;
		if (line[0] === ' ' || line[0] === '\t') {
			if (lines.length > 0) lines.push(line);
			continue;
		}
		flush();
		lines.push(line);
	}
	flush();
	return fields;
}

/**
 * The fields `names` select, in that order (RFC 6376 §5.4.2): each name
 * takes the last instance of that name not yet taken, so a name listed
 * twice takes the two lowest. A name listed more often than the message
 * has it selects nothing — the empty string a verifier hashes, which is
 * what makes over-signing refuse a field added later.
 */
export function selectFields(
	fields: readonly RawField[],
	names: readonly string[],
): RawField[] {
	const taken = new Map<string, number>();
	const selected: RawField[] = [];
	for (const wanted of names) {
		const name = lowerAscii(wanted);
		let index = taken.get(name) ?? fields.length;
		do index--;
		while (index >= 0 && fields[index]?.name !== name);
		taken.set(name, Math.max(index, -1));
		const field = index >= 0 ? fields[index] : undefined;
		if (field !== undefined) selected.push(field);
	}
	return selected;
}
