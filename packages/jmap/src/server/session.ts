import { COLLATION } from '../api/query';
import { CORE, MAIL } from '../api/request';
import { EMAIL_SORTS } from '../email/query';
import type { Authenticated } from '../http/auth';
import type { Settings } from './settings';

/** The URLs a session announces (RFC 8620 §2), for an origin and a base path. */
export function urlsOf(settings: Settings) {
	const base = `${settings.origin}${settings.basePath}`;
	return {
		apiUrl: `${base}/api`,
		downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?accept={type}`,
		uploadUrl: `${base}/upload/{accountId}`,
		eventSourceUrl: `${base}/eventsource?types={types}&closeafter={closeafter}&ping={ping}`,
	};
}

function capabilitiesOf(settings: Settings) {
	const { limits } = settings;
	return {
		[CORE]: {
			maxSizeUpload: limits.maxSizeUpload,
			maxConcurrentUpload: limits.maxConcurrentUpload,
			maxSizeRequest: limits.maxSizeRequest,
			maxConcurrentRequests: limits.maxConcurrentRequests,
			maxCallsInRequest: limits.maxCallsInRequest,
			maxObjectsInGet: limits.maxObjectsInGet,
			maxObjectsInSet: limits.maxObjectsInSet,
			collationAlgorithms: [COLLATION],
		},
		[MAIL]: {},
	};
}

/** The Session object (RFC 8620 §2) for an authenticated account. */
export function sessionOf(settings: Settings, auth: Authenticated) {
	const session = {
		capabilities: capabilitiesOf(settings),
		accounts: {
			[auth.accountId]: {
				name: auth.username,
				isPersonal: true,
				isReadOnly: false,
				accountCapabilities: {
					[MAIL]: {
						maxMailboxesPerEmail: null,
						maxMailboxDepth: null,
						maxSizeMailboxName: 255,
						maxSizeAttachmentsPerEmail: settings.limits.maxSizeUpload,
						emailQuerySortOptions: EMAIL_SORTS,
						mayCreateTopLevelMailbox: true,
					},
				},
			},
		},
		primaryAccounts: { [MAIL]: auth.accountId },
		username: auth.username,
		...urlsOf(settings),
	};
	const state = new Bun.CryptoHasher('sha256')
		.update(JSON.stringify(session))
		.digest('hex')
		.slice(0, 16);
	return { ...session, state };
}
