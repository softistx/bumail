import { describe } from 'bun:test';
import { describeAccounts } from './fixtures/accounts.fixtures';
import { describeChanges } from './fixtures/changes.fixtures';
import { describeChangesFilter } from './fixtures/changes-filter.fixtures';
import { describeChangesPaging } from './fixtures/changes-paging.fixtures';
import { describeContent } from './fixtures/content.fixtures';
import { describeFlags } from './fixtures/flags.fixtures';
import { describeGuarantees } from './fixtures/guarantees.fixtures';
import { describeMailboxes } from './fixtures/mailboxes.fixtures';
import { describeMessages } from './fixtures/messages.fixtures';
import { describeMoves } from './fixtures/moves.fixtures';
import { describeRenames } from './fixtures/renames.fixtures';
import type { CreateStore } from './fixtures/setup.fixtures';
import {
	type CreateForgetful,
	describeTombstones,
} from './fixtures/tombstones.fixtures';

/**
 * The specs every `MailStore` must pass. Each store's own spec calls this
 * with a factory, so the memory store and every other answer to the
 * contract are held to the same behaviour. A store that forgets old
 * removals also passes `forgetful`, a factory for one that remembers at
 * most that many, so the floor's specs run for it too.
 */
export function describeMailStore(
	name: string,
	create: CreateStore,
	forgetful?: CreateForgetful,
): void {
	describe(`${name}: the MailStore contract`, () => {
		describeAccounts(create);
		describeMailboxes(create);
		describeRenames(create);
		describeMessages(create);
		describeContent(create);
		describeFlags(create);
		describeMoves(create);
		describeChanges(create);
		describeChangesFilter(create);
		describeChangesPaging(create);
		describeGuarantees(create);
		if (forgetful) describeTombstones(forgetful);
	});
}
