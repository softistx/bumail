import type { MailStore } from '@bumail/store';
import { MethodError } from './errors';

/**
 * The account's state: its modseq, as a string. Mailbox, Email and
 * Thread share it, since one counter moves for every change. The store has
 * no call for the modseq alone, so it is read from the mailbox changes
 * since 0, which list every mailbox id and end at the current modseq.
 */
export async function stateOf(
	store: MailStore,
	accountId: string,
): Promise<string> {
	return String((await store.mailboxChanges(accountId, 0)).modseq);
}

/** A state a client sent back, as the modseq it stands for. */
export function sinceOf(state: unknown): number {
	if (typeof state !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(state)) {
		throw new MethodError(
			'cannotCalculateChanges',
			'The state is not one this server gave',
		);
	}
	const since = Number(state);
	if (!Number.isSafeInteger(since)) {
		throw new MethodError(
			'cannotCalculateChanges',
			'The state is not one this server gave',
		);
	}
	return since;
}

/** RFC 8620 §5.3 `ifInState`: refused when the account moved on. */
export async function checkIfInState(
	store: MailStore,
	accountId: string,
	ifInState: unknown,
): Promise<string> {
	const state = await stateOf(store, accountId);
	if (ifInState === undefined || ifInState === null) return state;
	if (ifInState !== state) {
		throw new MethodError(
			'stateMismatch',
			'The account has changed since ifInState',
		);
	}
	return state;
}
