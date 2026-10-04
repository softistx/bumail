import { checkCount } from '../contract/checks';
import { flagsAfter, normalizeChange } from '../contract/flags';
import type { FlagChange, FlagResult } from '../contract/types';
import { messagesOf, touch } from './membership';
import type { PgState } from './state';

/** Changes the flags of messages; each one changed takes a new modseq. */
export function setFlags(
	state: PgState,
	accountId: string,
	ids: readonly string[],
	change: FlagChange,
	unchangedSince: number | undefined,
): Promise<FlagResult> {
	checkCount('unchangedSince', unchangedSince);
	const clean = normalizeChange(change);
	return state.write(accountId, async (w) => {
		const { found, notFound } = await messagesOf(w, ids);
		const kept: string[] = [];
		const modified: string[] = [];
		for (const row of found) {
			const flags = flagsAfter(row, clean, unchangedSince);
			if (flags === 'modified') {
				modified.push(row.id);
				continue;
			}
			if (flags) {
				await w.rows(
					`UPDATE ${w.t.messages} SET flags = $1::text::jsonb WHERE id = $2`,
					[JSON.stringify(flags), row.id],
				);
				await touch(w, row);
			}
			kept.push(row.id);
		}
		return {
			messages: await w.freshViews(accountId, kept),
			notFound,
			modified,
		};
	});
}
