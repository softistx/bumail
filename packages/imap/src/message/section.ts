import type { Entity } from './structure';

/** A BODY[section] (RFC 9051 §6.4.5): a part path, then what of it. */
export interface Section {
	/** Part numbers, `[]` for the message itself. */
	readonly path: readonly number[];
	readonly text?:
		| 'HEADER'
		| 'HEADER.FIELDS'
		| 'HEADER.FIELDS.NOT'
		| 'TEXT'
		| 'MIME';
	/** The field names of HEADER.FIELDS, as the client wrote them. */
	readonly fields?: readonly string[];
}

/** The section as a FETCH response names it: `1.2.HEADER.FIELDS (From To)`. */
export function sectionName(section: Section): string {
	const parts: string[] = [];
	if (section.path.length > 0) parts.push(section.path.join('.'));
	if (section.text) parts.push(section.text);
	const fields = section.fields ? ` (${section.fields.join(' ')})` : '';
	return `${parts.join('.')}${fields}`;
}

/** Whether a section reads the message's parts, so the whole structure. */
export function needsParts(section: Section): boolean {
	return section.path.length > 0;
}

/**
 * The parts a part number counts among (§6.4.5): a multipart's parts; the
 * parts of the message a message/rfc822 part holds; or the entity itself,
 * the only part 1 of a message that is not multipart.
 */
function partsOf(entity: Entity): readonly Entity[] {
	if (entity.children.length > 0) return entity.children;
	if (entity.message) return partsOf(entity.message);
	return [entity];
}

function partAt(root: Entity, path: readonly number[]): Entity | undefined {
	let entity: Entity | undefined = root;
	for (const n of path) {
		entity = entity && partsOf(entity)[n - 1];
		if (!entity) return undefined;
	}
	return entity;
}

/** Bytes of the message, by offsets: read from the blob only when sent. */
export interface Range {
	readonly start: number;
	readonly end: number;
}

/** What a section selects: a range of the message, a header to filter, or nothing (NIL). */
export type Selection =
	| { readonly range: Range }
	| {
			readonly header: Range;
			readonly fields: readonly string[];
			readonly not: boolean;
	  }
	| undefined;

/**
 * Where a section lies in a message whose structure was read. HEADER,
 * TEXT and HEADER.FIELDS of a part need a message/rfc822 part; of
 * anything else they select nothing.
 */
export function select(root: Entity, section: Section): Selection {
	const target = partAt(root, section.path);
	if (!target) return undefined;
	const { text } = section;
	if (text === undefined) {
		return {
			range:
				section.path.length === 0
					? { start: 0, end: root.end }
					: bodyOf(target),
		};
	}
	if (text === 'MIME') {
		return section.path.length === 0
			? undefined
			: { range: { start: target.start, end: target.bodyStart } };
	}
	const message = section.path.length === 0 ? root : target.message;
	if (!message) return undefined;
	if (text === 'TEXT') return { range: bodyOf(message) };
	const header = { start: message.start, end: message.bodyStart };
	if (text === 'HEADER') return { range: header };
	return {
		header,
		fields: section.fields ?? [],
		not: text === 'HEADER.FIELDS.NOT',
	};
}

function bodyOf(entity: Entity): Range {
	return { start: entity.bodyStart, end: entity.end };
}

/**
 * The fields of a header block whose names are (or, with `not`, are not)
 * in `names`, then the blank line (§6.4.5). One pass over the block.
 */
export function filterHeader(
	block: Uint8Array,
	names: readonly string[],
	not: boolean,
): Uint8Array {
	const wanted = new Set(names.map((name) => name.toLowerCase()));
	const decoder = new TextDecoder('latin1');
	const kept: Uint8Array[] = [];
	let keep = false;
	let start = 0;
	while (start < block.length) {
		let end = block.indexOf(0x0a, start);
		end = end < 0 ? block.length : end + 1;
		const line = block.subarray(start, end);
		const first = line[0];
		if (first !== 0x20 && first !== 0x09) {
			const colon = line.indexOf(0x3a);
			const name =
				colon > 0
					? decoder.decode(line.subarray(0, colon)).trim().toLowerCase()
					: '';
			keep = name !== '' && wanted.has(name) !== not;
		}
		if (keep && !(line.length <= 2 && (first === 0x0d || first === 0x0a)))
			kept.push(line);
		start = end;
	}
	kept.push(new Uint8Array([0x0d, 0x0a]));
	let size = 0;
	for (const line of kept) size += line.length;
	const out = new Uint8Array(size);
	let at = 0;
	for (const line of kept) {
		out.set(line, at);
		at += line.length;
	}
	return out;
}
