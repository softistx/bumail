import { isArray } from '../../encoding';
import { AcmeError } from '../../errors';
import { isObject } from '../body';
import { printable } from '../problem';
import type { AcmeDirectory, AcmeDirectoryMeta } from '../types';
import { Reader } from './reader';

/** The directory (RFC 8555 §7.1.1), its URLs checked. */
export function directoryOf(
	value: unknown,
	where: string,
	allowInsecure: boolean,
): AcmeDirectory {
	if (!isObject(value)) {
		throw new AcmeError(
			'BAD_RESPONSE',
			`${where}: the CA's directory is not a JSON object`,
		);
	}
	const read = new Reader(value, 'directory', where, allowInsecure);
	const directory: AcmeDirectory = {
		newNonce: read.url('newNonce'),
		newAccount: read.url('newAccount'),
		newOrder: read.url('newOrder'),
	};
	for (const member of [
		'revokeCert',
		'keyChange',
		'newAuthz',
		'renewalInfo',
	] as const) {
		const url = read.optionalUrl(member);
		if (url !== undefined) directory[member] = url;
	}
	const meta = metaOf(value['meta']);
	if (meta !== undefined) directory.meta = meta;
	return directory;
}

/** The directory's `meta`, keeping the members of the right type and dropping the rest. */
function metaOf(value: unknown): AcmeDirectoryMeta | undefined {
	if (!isObject(value)) return undefined;
	const meta: AcmeDirectoryMeta = {};
	const text = (member: string) => {
		const item = value[member];
		// a URL, as text: kept only without white space or control characters
		return typeof item === 'string' && /^[\x21-\x7e]{1,2048}$/.test(item)
			? item
			: undefined;
	};
	const terms = text('termsOfService');
	if (terms !== undefined) meta.termsOfService = terms;
	const website = text('website');
	if (website !== undefined) meta.website = website;
	const caa = value['caaIdentities'];
	if (isArray(caa)) {
		meta.caaIdentities = (caa as unknown[])
			.filter((item): item is string => typeof item === 'string')
			.slice(0, 100)
			.map((item) => printable(item, 256));
	}
	if (typeof value['externalAccountRequired'] === 'boolean') {
		meta.externalAccountRequired = value['externalAccountRequired'];
	}
	const profiles = value['profiles'];
	if (isObject(profiles)) {
		meta.profiles = Object.fromEntries(
			Object.entries(profiles)
				.filter(
					(entry): entry is [string, string] => typeof entry[1] === 'string',
				)
				.slice(0, 100)
				.map(([name, text]) => [printable(name, 64), printable(text, 512)]),
		);
	}
	return meta;
}
