import { domainOf } from '../directory/address';
import type { Directory } from '../directory/directory';

/** How `@bumail/smtp` lists the bare `RCPT TO:<postmaster>` in an envelope: no `@`. */
export const POSTMASTER = 'postmaster';

/**
 * The domain of an envelope or From address, after its last `@`, as the
 * directory keeps domains: lowercase, in A-labels. `''` for the bare
 * `postmaster` and for what is no domain name.
 *
 * `@bumail/smtp` hands the address on as the client spelt it — any case,
 * and under SMTPUTF8 a U-label (`bücher.example`) — and a From field is
 * whatever the user's client wrote. So the domain is normalised again
 * here, with the directory's own `domainOf`: the hosted-domain check, the
 * split between the store and the queue, and DKIM's `d=` then agree on
 * one spelling, whichever the client used.
 */
export function envelopeDomain(address: string): string {
	const at = address.lastIndexOf('@');
	if (at === -1) return '';
	return domainOf(address.slice(at + 1)) ?? '';
}

/**
 * The address the bare `<postmaster>` (RFC 5321 §4.5.1) stands for:
 * `postmaster` from the configuration, else `postmaster@` the first
 * hosted domain, by name; `undefined` with no domain hosted.
 */
export function postmasterAddress(
	directory: Directory,
	configured: string | undefined,
): string | undefined {
	if (configured !== undefined) return configured;
	const [first] = directory.domains.list();
	return first === undefined ? undefined : `${POSTMASTER}@${first.name}`;
}

/**
 * The users mail for `address` goes to, as the directory resolves it, the
 * bare `postmaster` as `postmasterAddress`; `undefined` when nobody here
 * has it.
 */
export function usersFor(
	directory: Directory,
	address: string,
	postmaster: string | undefined,
): readonly string[] | undefined {
	if (address.toLowerCase() === POSTMASTER) {
		const target = postmasterAddress(directory, postmaster);
		return target === undefined ? undefined : directory.resolve(target);
	}
	return directory.resolve(address);
}

/** The users a message for `to` goes to, each once: aliases expanded, the bare `postmaster` routed. */
export function usersOf(
	directory: Directory,
	to: readonly string[],
	postmaster: string | undefined,
): string[] {
	const users = new Set<string>();
	for (const address of to) {
		for (const user of usersFor(directory, address, postmaster) ?? []) {
			users.add(user);
		}
	}
	return [...users];
}
