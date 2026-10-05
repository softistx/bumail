import type { MailStore } from '@bumail/store';
import type { Uploads } from '../blob/uploads';
import type { JmapClient } from '../server/options';
import type { Settings } from '../server/settings';
import type { ReferenceBudget } from './refs';

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
	/** Who the request is from, for `onError`. */
	readonly client: JmapClient;
	/** Bytes of body values this request may still return. */
	bodyBudget: number;
	/** Bytes of JSON this request's back-references may still copy. */
	readonly references: ReferenceBudget;
}
