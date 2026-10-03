import { decodeEncodedWords, parseDate } from '@bumail/mime';
import { MessageContent } from '../fetch/content';
import type { Loaded } from '../mailbox/lookup';
import type { Selected } from '../mailbox/selected';
import { dayOf } from '../protocol/dates';
import { seqPositions, uidPositions } from '../protocol/sequence';
import type { Connection } from '../server/connection';
import type { SearchKey } from './keys';

/** ASCII letters to lower case, in a copy: what TEXT and BODY compare. */
function lower(bytes: Uint8Array): Uint8Array {
	const out = bytes.slice();
	for (let i = 0; i < out.length; i++) {
		const byte = out[i] as number;
		if (byte >= 0x41 && byte <= 0x5a) out[i] = byte + 0x20;
	}
	return out;
}

/**
 * Whether a stretch of the message holds `needle`, without case for ASCII.
 * The message streams by, chunk after chunk, with only `needle.length - 1`
 * bytes carried from one to the next: a search never holds a message.
 */
export async function contains(
	blob: Blob,
	start: number,
	needle: string,
): Promise<boolean> {
	const wanted = Buffer.from(
		lower(new TextEncoder().encode(needle.toLowerCase())),
	);
	if (wanted.length === 0) return true;
	let carry = new Uint8Array(0);
	for await (const chunk of blob.slice(start).stream()) {
		const window = new Uint8Array(carry.length + chunk.length);
		window.set(carry, 0);
		window.set(lower(chunk), carry.length);
		if (Buffer.from(window.buffer).indexOf(wanted) >= 0) return true;
		carry = window.slice(Math.max(0, window.length - (wanted.length - 1)));
	}
	return false;
}

/** One message as SEARCH sees it. */
export interface Candidate extends Loaded {
	readonly content: MessageContent;
}

/** The positions a set key names, worked out once per search: the key object is the cache key. */
const named = new WeakMap<SearchKey, Set<number>>();

function positionsOf(
	key: Extract<SearchKey, { kind: 'set' }>,
	view: Selected,
): Set<number> {
	let positions = named.get(key);
	if (!positions) {
		positions = new Set(
			key.uid
				? uidPositions(key.set, view.uids)
				: seqPositions(key.set, view.count, true),
		);
		named.set(key, positions);
	}
	return positions;
}

function compare(
	op: 'BEFORE' | 'ON' | 'SINCE',
	day: number,
	wanted: number,
): boolean {
	if (op === 'BEFORE') return day < wanted;
	if (op === 'ON') return day === wanted;
	return day >= wanted;
}

async function headerMatches(
	candidate: Candidate,
	name: string,
	value: string,
): Promise<boolean> {
	const root = await candidate.content.header();
	if (!root) return false;
	const values = root.headers.getAll(name);
	if (value === '') return values.length > 0;
	const needle = value.toLowerCase();
	return values.some((raw) =>
		decodeEncodedWords(raw).toLowerCase().includes(needle),
	);
}

async function sentDay(candidate: Candidate): Promise<number | undefined> {
	const root = await candidate.content.header();
	const value = root?.headers.get('date');
	const date = value === undefined ? undefined : parseDate(value);
	return date && dayOf(date);
}

/** Whether a message matches a key; content is read only for keys that need it. */
export async function matches(
	key: SearchKey,
	candidate: Candidate,
	view: Selected,
): Promise<boolean> {
	const { message } = candidate;
	switch (key.kind) {
		case 'const':
			return key.value;
		case 'flag': {
			// RFC 9051 §2.3.2: a keyword matches whatever its case.
			const wanted = key.flag.toLowerCase();
			const has = message.flags.some((flag) => flag.toLowerCase() === wanted);
			return has === key.set;
		}
		case 'size':
			return key.larger ? message.size > key.size : message.size < key.size;
		case 'set':
			return positionsOf(key, view).has(candidate.position);
		case 'date': {
			const day = key.sent
				? await sentDay(candidate)
				: dayOf(message.receivedAt);
			return day !== undefined && compare(key.op, day, key.day);
		}
		case 'header':
			return headerMatches(candidate, key.name, key.value);
		case 'text': {
			const blob = await candidate.content.blob();
			if (!blob) return false;
			const start = key.body
				? ((await candidate.content.header())?.bodyStart ?? 0)
				: 0;
			return contains(blob, start, key.value);
		}
		case 'not':
			return !(await matches(key.key, candidate, view));
		case 'or':
			return (
				(await matches(key.left, candidate, view)) ||
				matches(key.right, candidate, view)
			);
		case 'and':
			for (const inner of key.keys)
				if (!(await matches(inner, candidate, view))) return false;
			return true;
	}
}

/** The positions of the view's messages that match. */
export async function search(
	connection: Connection,
	view: Selected,
	key: SearchKey,
	loaded: readonly Loaded[],
): Promise<number[]> {
	const found: number[] = [];
	for (const entry of loaded) {
		const candidate = {
			...entry,
			content: new MessageContent(connection, entry.message),
		};
		if (await matches(key, candidate, view)) found.push(entry.position);
	}
	return found;
}
