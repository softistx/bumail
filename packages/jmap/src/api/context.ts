import type { MailStore } from '@bumail/store';
import type { Uploads } from '../blob/uploads';
import type { Settings } from '../server/settings';

/** What every method call of one request reads. */
export interface CallContext {
	readonly settings: Settings;
	readonly store: MailStore;
	/** The authenticated account: the only one any call may name. */
	readonly accountId: string;
	readonly using: ReadonlySet<string>;
	/** Creation ids to ids, from `createdIds` and every create so far (RFC 8620 §5.3). */
	readonly created: Map<string, string>;
	readonly uploads: Uploads;
	readonly request: Request;
	/** Bytes of body values this request may still return. */
	bodyBudget: number;
}
