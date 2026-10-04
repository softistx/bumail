import { importDkimPrivateKey, signDkim } from '@bumail/auth';
import { domainOf } from '../../directory/address';
import type { Directory } from '../../directory/directory';
import type { Signer } from './index';

/**
 * Signs with the directory's key for the From domain, read at each
 * message, so a key `bumail dkim generate` makes or replaces counts at
 * once; a domain with none goes unsigned. Each key is imported once.
 */
export function dkimSigner(directory: Directory): Signer {
	const imported = new Map<string, Promise<CryptoKey>>();
	return async (domain, message) => {
		// d= is the domain as the directory keeps it: its A-label.
		const name = domainOf(domain);
		const key =
			name === undefined ? undefined : directory.dkim.signingKey(name);
		if (name === undefined || key === undefined) {
			await message.cancel();
			return undefined;
		}
		let privateKey = imported.get(key.privateKey);
		if (privateKey === undefined) {
			const pem = key.privateKey;
			privateKey = importDkimPrivateKey(pem);
			// A key that does not import is tried again at the next message.
			privateKey.catch(() => imported.delete(pem));
			// One key per domain at a time: a replaced key is forgotten.
			if (imported.size > 1000) imported.clear();
			imported.set(key.privateKey, privateKey);
		}
		return signDkim(message, {
			domain: name,
			selector: key.selector,
			privateKey: await privateKey,
		});
	};
}
