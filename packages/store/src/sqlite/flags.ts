import { checkCount } from '../contract/checks';
import { flagsAfter, normalizeChange } from '../contract/flags';
import type { FlagChange, FlagResult } from '../contract/types';
import { touch } from './membership';
import { freshViews, messagesOf } from './rows';
import type { SqliteState } from './state';

/** Changes the flags of messages; each one changed takes a new modseq. */
export function setFlags(
	state: SqliteState,
	accountId: string,
	ids: readonly string[],
	change: FlagChange,
	unchangedSince: number | undefined,
): FlagResult {
	checkCount('unchangedSince', unchangedSince);
	const clean = normalizeChange(change);
	return state.atomic(() => {
		const { found, notFound } = messagesOf(state, accountId, ids);
		const kept: string[] = [];
		const modified: string[] = [];
		for (const row of found) {
			const flags = flagsAfter(
				{ flags: JSON.parse(row.flags) as string[], modseq: row.modseq },
				clean,
				unchangedSince,
			);
			if (flags === 'modified') {
				modified.push(row.id);
				continue;
			}
			if (flags) {
				state.db
					.query('UPDATE messages SET flags = ? WHERE id = ?')
					.run(JSON.stringify(flags), row.id);
				touch(state, row);
			}
			kept.push(row.id);
		}
		return {
			messages: freshViews(state, accountId, kept),
			notFound,
			modified,
		};
	});
}
