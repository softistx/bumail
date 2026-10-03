import { binary, trimFws } from '../text';

/** A tag=value list (RFC 6376 §3.2): names are case-sensitive, values trimmed of folding white space. */
export type TagList = ReadonlyMap<string, string>;

/** The tags, or why the text is not a tag list. */
export type TagListResult =
	| { readonly tags: TagList }
	| { readonly error: string };

const NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/**
 * Parses `tag-list = tag-spec *( ";" tag-spec ) [ ";" ]`. A tag without
 * `=`, a name that is not `ALPHA *ALNUMPUNC`, an empty tag between two
 * semicolons, or a tag given twice is an error (§3.2: "Tags with duplicate
 * names MUST NOT occur within a single tag-list"). Unknown tags are kept:
 * the caller ignores them.
 */
export function parseTagList(text: string): TagListResult {
	const tags = new Map<string, string>();
	const specs = text.split(';');
	for (let i = 0; i < specs.length; i++) {
		const spec = trimFws(specs[i] ?? '');
		if (spec === '') {
			if (i === specs.length - 1 && i > 0) break;
			return { error: 'malformed tag list: an empty tag' };
		}
		const equals = spec.indexOf('=');
		if (equals < 0) {
			return { error: `malformed tag list: "${clip(spec)}" has no "="` };
		}
		const name = trimFws(spec.slice(0, equals));
		if (!NAME.test(name)) {
			return {
				error: `malformed tag list: "${clip(name)}" is not a tag name`,
			};
		}
		if (tags.has(name)) return { error: `duplicate tag ${name}=` };
		tags.set(name, trimFws(spec.slice(equals + 1)));
	}
	return { tags };
}

/** A value with every folding white space removed, as `b=`, `bh=` and `p=` are read. */
export function withoutFws(value: string): string {
	return value.replace(/[ \t\r\n]+/g, '');
}

/** A colon-separated list (`h=`, `q=`, key `h=` and `s=`), each item trimmed. */
export function colonList(value: string): string[] {
	return value.split(':').map(trimFws);
}

/** A piece of hostile input short enough to quote in a reason. */
export function clip(text: string): string {
	return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

const BASE64 =
	/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The bytes of a base64 value (white space already removed), or `undefined` when it is not base64. */
export function decodeBase64Strict(text: string): Uint8Array | undefined {
	if (!BASE64.test(text)) return undefined;
	const decoded = atob(text);
	const bytes = new Uint8Array(decoded.length);
	for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
	return bytes;
}

/** Bytes as base64. */
export function encodeBase64(bytes: Uint8Array): string {
	return btoa(binary(bytes));
}
